import { chromium } from "playwright";
import MailComposer from "nodemailer/lib/mail-composer";
import { readFile } from "fs/promises";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { DemandeIntervention, PrismaClient } from "@prisma/client";
import { logEvenement } from "./journalService";
import { marquerDemandeInterventionSaisie } from "./demandesIntervention";
import { getGmailClient } from "./googleAuth";

dayjs.extend(utc);
dayjs.extend(timezone);
const FUSEAU = "Europe/Paris";
import {
  CHEMIN_CAPTURE_ECHEC,
  capturerDiagnostic,
  cliquerSiVisible,
  fermerDialoguesResiduels,
  obtenirIdentifiants,
  ouvrirMenuFacturation,
  seConnecter,
} from "./synecSync";

/**
 * Écriture automatique dans Synec (client + planning), pendant Synec via
 * navigateur headless - PAS une API, Synec n'en propose aucune (voir
 * synecSync.ts pour le parallèle côté lecture). Construit à partir d'une
 * vidéo fournie par l'utilisateur montrant les deux étapes à la main :
 * Clients → Nouveau client, puis Planning → Nouvel événement relié à ce
 * client.
 *
 * Contrairement à la lecture (export de factures, sans risque), ceci écrit
 * dans la vraie comptabilité de l'utilisateur : chaque étape est aussi
 * prudente que possible (recherche du client AVANT toute création, jamais
 * de doublon volontaire), mais reste une automatisation par clics, donc
 * fragile face à la moindre évolution de l'interface Synec - comme pour la
 * lecture, un échec capture une image de l'écran bloquant plutôt que de
 * laisser deviner. Déclenchée uniquement par un clic explicite de
 * l'utilisateur sur une demande précise (jamais automatique à la réception
 * d'un appel) : décision explicite, le sujet est encore trop récent pour
 * lui faire confiance sans supervision.
 */

export class SynecEcritureError extends Error {}

/**
 * Cherche un client existant par son NOM EXACT (insensible à la casse et
 * aux espaces de bord) dans le sélecteur "Client" du formulaire d'événement
 * - demande explicite de l'utilisateur ("on le recherche... avec son nom").
 * Un Select2 classique (confirmé par le message "Please enter 1 or more
 * characters", propre à cette librairie) : on ouvre le selecteur, on tape
 * le nom, on lit les résultats affichés. Une correspondance approximative
 * (le propre comportement de recherche de Select2, pas strictement un
 * sous-texte) ne suffit PAS à réutiliser une fiche : seule l'égalité exacte
 * du texte compte, pour ne jamais rattacher par erreur à un homonyme.
 */
async function chercherEtSelectionnerClient(page: import("playwright").Page, nom: string): Promise<boolean> {
  const normalise = (s: string) => s.trim().toLowerCase();

  // Echec reel (demande "Jouot") : le libelle "Client" et le bouton "+
  // Creer un nouveau client" partagent le meme parent proche (label), le
  // vrai menu deroulant select2 est un peu plus bas dans le DOM (hors de ce
  // parent) - remonter aux ancetres ne le trouvait donc jamais. Cherche
  // plutot le premier element select2-selection qui SUIT le libelle dans le
  // document - mais uniquement "--single" (un seul client) : "following::"
  // remonte sinon sur le select2 cache du champ multi-valeurs "Liste des
  // utilisateurs affectes a cette tache" plus bas dans la page (classe
  // select2-selection--multiple, confirme par un echec reel : "resolved to
  // hidden <span ... select2-selection--multiple>").
  const selecteur = page
    .getByText(/^client$/i)
    .first()
    .locator("xpath=following::*[contains(@class,'select2-selection--single')][1]");
  await selecteur.waitFor({ state: "visible", timeout: 8000 });
  await selecteur.click();

  // Echec reel : .select2-search__field (sans portee) resolvait sur un
  // champ cache d'un AUTRE widget select2 present ailleurs sur la page
  // (placeholder "Search for a repository", rien a voir avec Synec). Le
  // menu qu'on vient d'ouvrir recoit la classe "select2-container--open" -
  // on y limite desormais la recherche du champ ET des resultats, pour ne
  // plus jamais retomber sur un autre widget select2 de la page.
  const menuOuvert = page.locator(".select2-container--open");
  const champRecherche = menuOuvert.locator(".select2-search__field").first();
  await champRecherche.waitFor({ state: "visible", timeout: 5000 });
  await champRecherche.fill(nom);
  await page.waitForTimeout(1200); // laisse la recherche (debounce + requete reseau) revenir

  const resultats = menuOuvert.locator(".select2-results__option");
  const nombre = await resultats.count().catch(() => 0);
  for (let i = 0; i < nombre; i++) {
    const texte = (await resultats.nth(i).textContent().catch(() => null))?.trim();
    if (texte && normalise(texte.replace(/^#\d+\s*/, "")) === normalise(nom)) {
      await resultats.nth(i).click();
      return true;
    }
  }

  // Aucune correspondance exacte : referme le selecteur sans rien choisir
  // (touche Echap, pattern Select2 standard) pour laisser l'appelant decider.
  await page.keyboard.press("Escape").catch(() => {});
  return false;
}

async function remplirApresLibelle(page: import("playwright").Page, libelle: RegExp, valeur: string): Promise<void> {
  const label = page.getByText(libelle).first();
  await label.waitFor({ state: "visible", timeout: 5000 });
  const champ = label.locator("xpath=following::input[1] | following::textarea[1]").first();
  await champ.fill(valeur);
}

/**
 * Atteint l'écran "Planning" (menu ☰ → Facturation → Planning, ou
 * directement un lien "Planning" quand Synec affiche la barre laterale
 * fixe de type AdminLTE plutot que le tiroir mobile habituel - repere sur
 * un premier echec reel : "facturation:false" (pas d'accordeon a deplier
 * sur cette variante de page) suivi quand meme de "planning:true" (le lien
 * existe directement dans la barre laterale), preuve que cette variante
 * arrive bel et bien en production).
 *
 * "Nouvel événement" (bouton sous la liste des 59 evenements, paginee) met
 * plus longtemps a s'afficher que "Calendrier visuel" (rendu des le debut
 * du chargement) - un premier echec reel a montre un timeout de 5s trop
 * court alors que la page avait fini de charger quelques centaines de
 * millisecondes plus tard (capture de diagnostic prise juste apres montre
 * deja le bon ecran) : les deux reperes sont donc verifies en parallele,
 * avec une marge plus large. Un second echec reel a depasse cette marge de
 * 12s (diagnostic capture quelques secondes plus tard montrait deja le
 * calendrier charge, evenements compris) : portee a 25s, le chargement du
 * calendrier visuel restant le plus lent des deux reperes (il attend les
 * evenements du mois, pas juste la structure de la page).
 */
async function allerAuPlanning(page: import("playwright").Page): Promise<void> {
  const dejaSurPlanning = async () => {
    const resultats = await Promise.all([
      page
        .getByText(/nouvel événement/i)
        .first()
        .waitFor({ state: "visible", timeout: 25000 })
        .then(() => true)
        .catch(() => false),
      page
        .getByText(/calendrier visuel/i)
        .first()
        .waitFor({ state: "visible", timeout: 25000 })
        .then(() => true)
        .catch(() => false),
    ]);
    return resultats.some(Boolean);
  };

  if (await dejaSurPlanning()) return;

  const { etapes, diagnosticApresMenu, candidats } = await ouvrirMenuFacturation(page);
  etapes.push(`planning:${await cliquerSiVisible(page, /^planning$/i)}`);

  await page.waitForLoadState("networkidle");
  if (await dejaSurPlanning()) return;

  const diagnostic = await capturerDiagnostic(page);
  throw new SynecEcritureError(
    `Écran "Planning" introuvable (étapes : ${etapes.join(", ")}).` +
      (candidats ? ` ${candidats}` : "") +
      (diagnosticApresMenu ? ` Juste après le clic sur le menu : ${diagnosticApresMenu}` : "") +
      ` État final : ${diagnostic}`
  );
}

/**
 * Clique sur "Nouvel événement" pour ouvrir le formulaire de création.
 * Echec reel (demande "Jouot") malgre allerAuPlanning() revenu sans
 * erreur : celui-ci se satisfait de "calendrier visuel" seul (repere le
 * plus rapide des deux, voir plus haut), ce qui laisse chercherEtSelec...
 * potentiellement 0s de marge reelle pour "nouvel événement" (le plus
 * lent des deux, bouton sous la liste paginee des evenements) avant de le
 * cliquer - l'ancien code s'appuyait alors sur le seul timeout implicite
 * de Playwright (30s par defaut sur .click()), deja observe insuffisant.
 * Attente explicite, et plus large, avant le clic.
 *
 * Deuxieme echec reel (meme demande "Jouot", reouverture de ce meme
 * formulaire juste apres la creation d'un client) : le clic est intercepte
 * par la fenetre "Création d'un nouvel événement" de l'etape precedente,
 * toujours presente dans le DOM malgre un enregistrement reussi - exactement
 * le dialogue fantome deja rencontre sur le bouton ☰ (voir
 * fermerDialoguesResiduels dans synecSync.ts). Meme traitement ici : fermer
 * les dialogues residuels avant chaque tentative de clic, en boucle.
 */
async function ouvrirNouvelEvenement(page: import("playwright").Page): Promise<void> {
  const bouton = page.getByText(/nouvel événement/i).first();
  await bouton.waitFor({ state: "visible", timeout: 45000 });

  const debutTentatives = Date.now();
  let clique = false;
  while (!clique && Date.now() - debutTentatives < 60000) {
    await fermerDialoguesResiduels(page);
    clique = await bouton
      .click({ timeout: 3000 })
      .then(() => true)
      .catch(() => false);
  }
  if (!clique) await bouton.click();

  await page.getByText(/création d'un nouvel événement/i).first().waitFor({ state: "visible", timeout: 8000 });
}

const LIBELLE_SOURCE_SYNEC: Record<string, string> = { google: "Google", pages_jaunes: "Pages Jaunes", maps: "Maps" };
const LIBELLE_CATEGORIE_SYNEC: Record<string, string> = {
  plomberie: "Plomberie",
  serrurerie: "Serrurerie",
  electricite: "Électricité",
  assainissement: "Assainissement",
};

/**
 * Selectionne une option dans un menu (natif <select> ou select2) repere
 * par un libelle visible qui le precede - best effort, jamais bloquant
 * (champ non confirme en l'absence d'acces direct a Synec pour verifier le
 * libelle exact du champ cote Synec, contrairement aux champs deja
 * confirmes par la video de l'utilisateur). Essaie d'abord un <select>
 * natif, puis un widget select2 (meme famille que le champ "Client" -
 * ouvre le menu, cherche l'option dont le texte CONTIENT la valeur visee).
 */
async function remplirMenuApresLibelle(page: import("playwright").Page, libelle: RegExp, texteOption: string): Promise<boolean> {
  const label = page.getByText(libelle).first();
  const labelVisible = await label
    .waitFor({ state: "visible", timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  if (!labelVisible) return false;

  const selectNatif = label.locator("xpath=following::select[1]").first();
  if (await selectNatif.count().then((c) => c > 0).catch(() => false)) {
    const choisi = await selectNatif
      .selectOption({ label: texteOption })
      .then(() => true)
      .catch(() => false);
    if (choisi) return true;
  }

  const selecteur = label.locator("xpath=following::*[contains(@class,'select2-selection')][1]");
  const select2Visible = await selecteur
    .waitFor({ state: "visible", timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (!select2Visible) return false;

  await selecteur.click();
  const menuOuvert = page.locator(".select2-container--open");
  const resultats = menuOuvert.locator(".select2-results__option");
  await page.waitForTimeout(500);
  const nombre = await resultats.count().catch(() => 0);
  for (let i = 0; i < nombre; i++) {
    const texte = (await resultats.nth(i).textContent().catch(() => null))?.trim();
    if (texte && texte.toLowerCase().includes(texteOption.toLowerCase())) {
      await resultats.nth(i).click();
      return true;
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
  return false;
}

/**
 * Remplit et enregistre le formulaire "Création d'un client" (deja
 * ouvert), quel que soit le chemin utilise pour l'ouvrir. Volontairement
 * minimal : seuls les champs que l'intake collecte deja sont remplis (nom,
 * telephone, e-mail, adresse) - Attestation TVA, prenom/nom separes
 * laisses tels quels ("trop tot pour automatiser", decision explicite de
 * l'utilisateur), a completer a la main dans Synec si besoin.
 *
 * Source d'acquisition / Categorie (demande explicite de l'utilisateur,
 * "comme Synec" pour la source) : libelle exact cote Synec non confirme
 * par une capture ou une video (contrairement aux autres champs ci-dessus)
 * - best effort via remplirMenuApresLibelle, qui n'interrompt jamais la
 * creation du client si le champ attendu n'est pas trouve avec ce libelle.
 *
 * Echec reel sur la confirmation : le texte "enregistré" (sans portee)
 * pouvait deja etre present ailleurs sur la page (aide/texte statique)
 * avant meme le clic, donnant une fausse confirmation immediate - seul
 * signal fiable, la disparition effective de la fenetre elle-meme.
 */
async function remplirEtEnregistrerFicheClient(page: import("playwright").Page, demande: DemandeIntervention): Promise<void> {
  const enTeteFormulaire = page.getByText(/création d'un client/i).first();
  await enTeteFormulaire.waitFor({ state: "visible", timeout: 8000 });

  // Diagnostic (echecs reels successifs sur le clic final, meme avec
  // { force: true }) : compte le nombre de fenetres "Création d'un
  // client" a plusieurs etapes, pour savoir si le dedoublement existe des
  // l'ouverture (probable comportement Synec, duplique pour une raison de
  // mise en page) ou apparait seulement plus tard (probable consequence
  // d'une de nos propres actions).
  const compteOuverture = await page.getByText(/création d'un client/i).count();

  // Memes valeurs dans "Nom principal du client" (General) ET "Nom"
  // (Facturation) : reproduit exactement ce que l'utilisateur a fait dans
  // sa propre video de demonstration, plutot que de deviner un autre choix.
  await remplirApresLibelle(page, /nom principal du client/i, demande.nom);
  if (demande.telephone) await remplirApresLibelle(page, /téléphones pour envoi factures\/devis/i, demande.telephone);
  if (demande.email) await remplirApresLibelle(page, /mails pour envoi factures\/devis/i, demande.email);
  await remplirApresLibelle(page, /^nom$/i, demande.nom);
  if (demande.adresse) await remplirApresLibelle(page, /ligne d'adresse 1/i, demande.adresse);
  if (demande.codePostal) await remplirApresLibelle(page, /code postal/i, demande.codePostal);
  if (demande.ville) await remplirApresLibelle(page, /^ville$/i, demande.ville);
  if (demande.sourceAcquisition && LIBELLE_SOURCE_SYNEC[demande.sourceAcquisition]) {
    await remplirMenuApresLibelle(page, /source d'acquisition/i, LIBELLE_SOURCE_SYNEC[demande.sourceAcquisition]).catch(() => {});
  }
  if (demande.categorie && LIBELLE_CATEGORIE_SYNEC[demande.categorie]) {
    await remplirMenuApresLibelle(page, /(catégorie|corps de métier)/i, LIBELLE_CATEGORIE_SYNEC[demande.categorie]).catch(() => {});
  }

  // Echec reel decisif : un essai rate ("0 bouton trouve") montrait
  // pourtant, sur la capture de diagnostic prise au meme instant, le
  // bouton "Enregistrer et fermer" bel et bien visible et intact. Cause
  // trouvee : getByText(/^enregistrer et fermer$/i) exige une
  // correspondance EXACTE (ancres ^...$), alors que le tout premier
  // diagnostic qui avait reussi a lister ce bouton utilisait une
  // correspondance PARTIELLE (texte contenant "enregistrer et fermer",
  // sans ancres) - un espace insecable ou un caractere invisible genere
  // par Synec dans ce texte suffit a faire echouer l'egalite stricte.
  // Retire les ancres : simple sous-chaine, comme le diagnostic qui a
  // fonctionne.
  await page.waitForLoadState("networkidle").catch(() => {});

  const compteAvantEnregistrer = await page.getByText(/création d'un client/i).count();
  const compteBoutons = await page.getByText(/enregistrer et fermer/i).count();

  let dernierEchec: Error | undefined;
  let clique = false;
  for (let essai = 1; essai <= 4 && !clique; essai++) {
    const bouton = page.getByText(/enregistrer et fermer/i).first();
    clique = await bouton
      .click({ force: true, timeout: 6000 })
      .then(() => true)
      .catch((err) => {
        dernierEchec = err as Error;
        return false;
      });
    if (!clique) await page.waitForTimeout(2000);
  }
  if (!clique) {
    const compteApresEchec = await page.getByText(/création d'un client/i).count().catch(() => -1);
    throw new SynecEcritureError(
      `Clic "Enregistrer et fermer" impossible apres 4 essais. Fenetres "Création d'un client" : a l'ouverture=${compteOuverture}, avant le clic=${compteAvantEnregistrer}, apres l'echec=${compteApresEchec}. Boutons "Enregistrer et fermer" trouves=${compteBoutons}. Erreur : ${dernierEchec?.message}`
    );
  }

  const confirme = await enTeteFormulaire
    .waitFor({ state: "hidden", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!confirme) {
    const diagnostic = await capturerDiagnostic(page);
    throw new SynecEcritureError(`La fiche client ne semble pas enregistrée (fenêtre toujours ouverte). État final : ${diagnostic}`);
  }
}

/**
 * Cree le client directement depuis le raccourci "+ Créer un nouveau
 * client" integre a la fenetre de creation d'evenement (visible dans la
 * video de l'utilisateur, juste a cote du champ "Client") - le chemin que
 * l'utilisateur emprunte reellement. L'ancien chemin (fermer cette
 * fenetre, detour par l'ecran "Clients", puis rouvrir un evenement)
 * provoquait un dialogue fantome recidivant, jamais observe par
 * l'utilisateur en usage normal : preuve que ce detour ne correspond pas
 * au fonctionnement reel de Synec.
 */
async function creerClientDepuisFormulaireEvenement(page: import("playwright").Page, demande: DemandeIntervention): Promise<void> {
  const boutonCreerClient = page.getByText(/créer un nouveau client/i).first();
  await boutonCreerClient.waitFor({ state: "visible", timeout: 8000 });
  await boutonCreerClient.click();
  await remplirEtEnregistrerFicheClient(page, demande);
}

function construireDescriptionEvenement(demande: DemandeIntervention): string {
  const lignes: string[] = [];
  if (demande.motif) lignes.push(demande.motif);
  if (demande.urgence === "urgente") lignes.push("URGENT");
  if (demande.typeLogement) {
    lignes.push(
      demande.typeLogement === "appartement"
        ? `Appartement${demande.etage ? `, étage ${demande.etage}` : ""}${demande.codeAcces ? `, code ${demande.codeAcces}` : ""}`
        : "Maison"
    );
  } else if (demande.codeAcces) {
    lignes.push(`Code accès : ${demande.codeAcces}`);
  }
  if (demande.telephone) lignes.push(`Tél. : ${demande.telephone}`);
  return lignes.join("\n") || "Intervention.";
}

/**
 * "JJ/MM/AAAA HH:mm", format observe dans le champ de date de l'evenement
 * (video de l'utilisateur). Formate en heure de Paris (pas celle, souvent
 * UTC, du serveur) : meme principe que formaterCreneau dans agenda.ts.
 */
function formaterDateHeureSynec(d: Date): string {
  return dayjs(d).tz(FUSEAU).format("DD/MM/YYYY HH:mm");
}

/**
 * Remplit la zone "Description" de l'événement - un éditeur de texte riche
 * (barre d'outils gras/italique/souligné...), pas un simple <textarea>.
 *
 * Echec reel (vidéo fournie par l'utilisateur, demande "Jouot") : le champ
 * "Description" reste visiblement VIDE dans Synec après l'envoi, alors que
 * le code précédent cliquait et tapait sans lever d'erreur. Cause la plus
 * probable : ce type d'éditeur (barre d'outils identique à TinyMCE) place
 * souvent sa vraie zone éditable DANS UN <iframe> - invisible par défaut
 * pour `page.locator()`, qui ne cherche jamais dans les iframes sans qu'on
 * le lui demande explicitement. Le premier `[contenteditable="true"]` de la
 * page principale matchait donc probablement un AUTRE élément (silencieux,
 * aucune erreur), d'où une saisie qui semblait réussir sans jamais se
 * retrouver dans le bon champ.
 *
 * Essaie dans l'ordre : la zone qui suit directement le libellé
 * "Description" dans la page principale, puis le premier contenteditable
 * de la page principale (comportement précédent, au cas où), puis chaque
 * iframe de la page. Vérifie à chaque essai que le texte est bien repassé
 * en lecture (innerText) avant de considérer l'essai réussi - sinon passe
 * au suivant plutôt que de s'arrêter sur un faux succès.
 */
async function remplirDescriptionEvenement(page: import("playwright").Page, texte: string): Promise<boolean> {
  const essayer = async (zone: import("playwright").Locator): Promise<boolean> => {
    const visible = await zone.isVisible().catch(() => false);
    if (!visible) return false;
    await zone.click().catch(() => {});
    await zone.type(texte).catch(() => {});
    const contenu = (await zone.innerText().catch(() => "")).trim();
    return contenu.length > 0;
  };

  const libelle = page.getByText(/^description$/i).first();
  const libelleVisible = await libelle
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (libelleVisible) {
    const zoneProche = libelle.locator("xpath=following::*[@contenteditable='true'][1]");
    if (await essayer(zoneProche)) return true;
  }

  if (await essayer(page.locator('[contenteditable="true"]').first())) return true;

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    if (await essayer(frame.locator('[contenteditable="true"], body#tinymce').first())) return true;
  }

  return false;
}

/** Crée l'événement de planning relié au client (déjà sélectionné dans le formulaire ouvert). */
async function remplirEvenement(page: import("playwright").Page, demande: DemandeIntervention): Promise<void> {
  const statut = page.locator("select").filter({ has: page.getByText(/pas de statut/i) }).first();
  await statut
    .selectOption({ label: "PLANIFIER" })
    .catch(() => {
      // Si ce selecteur precis n'est pas un <select> natif (menu personnalise
      // non prevu), on laisse le statut par defaut plutot que d'echouer toute
      // la creation pour un champ non bloquant.
    });

  // Date/heure souhaitee par le client (demande explicite : "pour que ca
  // puisse remonter automatiquement") : sans elle, Synec garde son defaut
  // (l'instant de creation de l'evenement). Non bloquant si le champ ne
  // reagit pas a .fill() (saisie masquee non confirmee sans acces direct a
  // Synec) : l'evenement est alors cree avec la date par defaut plutot que
  // d'echouer toute la demande pour ce seul champ.
  //
  // Fin explicite (dateSouhaiteeFin, demande explicite de l'utilisateur :
  // "rendez-vous... entre 11 heures et midi" -> debut ET fin precis, pas
  // une duree fixe devinee) quand elle est fournie ; a defaut (anciennes
  // demandes saisies avant l'ajout de ce champ, ou champ laisse vide),
  // repli sur l'ancien calcul debut+1h plutot que de laisser la fin vide.
  if (demande.dateSouhaitee) {
    const debut = demande.dateSouhaitee;
    const fin = demande.dateSouhaiteeFin || new Date(debut.getTime() + 60 * 60 * 1000);
    await remplirApresLibelle(page, /date de début de l'événement/i, formaterDateHeureSynec(debut)).catch(() => {});
    await remplirApresLibelle(page, /date de fin de l'événement/i, formaterDateHeureSynec(fin)).catch(() => {});
  }

  const champNom = page.getByText(/^nom$/i).last().locator("xpath=following::input[1]").first();
  await champNom
    .fill(`${demande.nom} — ${demande.urgence === "urgente" ? "URGENT" : "intervention"}`)
    .catch(() => {});

  await remplirDescriptionEvenement(page, construireDescriptionEvenement(demande));

  // Meme correctif que pour la fiche client (remplirEtEnregistrerFicheClient)
  // : sous-chaine plutot que correspondance exacte (un caractere invisible
  // peut faire echouer l'egalite stricte), reseau calme avant le clic, et
  // plusieurs tentatives plutot qu'un essai unique.
  await page.waitForLoadState("networkidle").catch(() => {});
  let evenementEnregistre = false;
  let dernierEchecEvenement: Error | undefined;
  for (let essai = 1; essai <= 4 && !evenementEnregistre; essai++) {
    const bouton = page.getByText(/enregistrer et fermer/i).first();
    evenementEnregistre = await bouton
      .click({ force: true, timeout: 6000 })
      .then(() => true)
      .catch((err) => {
        dernierEchecEvenement = err as Error;
        return false;
      });
    if (!evenementEnregistre) await page.waitForTimeout(2000);
  }
  if (!evenementEnregistre) {
    const diagnostic = await capturerDiagnostic(page);
    throw new SynecEcritureError(
      `L'événement ne semble pas enregistré (bouton "Enregistrer et fermer" introuvable apres 4 essais : ${dernierEchecEvenement?.message}). État final : ${diagnostic}`
    );
  }

  // Echec reel (test "TEST-CLAUDE2") : ce seul signal (le titre du dialogue
  // devient "hidden") a depasse son delai de 10s, alors que la capture de
  // diagnostic prise juste apres montrait deja l'ecran Planning propre
  // (l'enregistrement avait donc bel et bien reussi, juste plus lentement
  // que prevu) - delai elargi, et second signal en parallele (retour
  // visible sur Planning, meme reperes que dejaSurPlanning dans
  // allerAuPlanning) plutot qu'un seul.
  const formulaireFerme = await Promise.all([
    page
      .getByText(/création d'un nouvel événement/i)
      .first()
      .waitFor({ state: "hidden", timeout: 25000 })
      .then(() => true)
      .catch(() => false),
    page
      .getByText(/calendrier visuel/i)
      .first()
      .waitFor({ state: "visible", timeout: 25000 })
      .then(() => true)
      .catch(() => false),
  ]).then((resultats) => resultats.some(Boolean));
  if (!formulaireFerme) {
    const diagnostic = await capturerDiagnostic(page);
    throw new SynecEcritureError(`L'événement ne semble pas enregistré. État final : ${diagnostic}`);
  }
}

export interface ResultatEnvoiSynec {
  clientReutilise: boolean;
}

/**
 * Envoie une demande d'intervention vers Synec (client + planning),
 * déclenché par un clic explicite de l'utilisateur sur CETTE demande
 * précise (jamais automatique). Marque la demande "saisie" seulement après
 * confirmation que l'événement est bien enregistré côté Synec.
 */
export async function envoyerDemandeVersSynec(prisma: PrismaClient, demandeId: string): Promise<ResultatEnvoiSynec> {
  const demande = await prisma.demandeIntervention.findUnique({ where: { id: demandeId } });
  if (!demande) throw new SynecEcritureError("Demande introuvable.");
  if (demande.statut === "saisie") throw new SynecEcritureError("Cette demande est déjà marquée comme saisie.");

  const { url, identifiant, motDePasse } = obtenirIdentifiants();

  const navigateur = await chromium.launch({ headless: true });
  let page: import("playwright").Page | undefined;
  try {
    // Meme largeur que synecSync.ts (telephone, pas bureau) : le menu ne se
    // comporte pas de la meme facon a une largeur de bureau, confirme en
    // production sur la synchronisation en lecture.
    page = await navigateur.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await seConnecter(page, identifiant, motDePasse);

    await allerAuPlanning(page);
    await ouvrirNouvelEvenement(page);

    let clientReutilise = await chercherEtSelectionnerClient(page, demande.nom);

    if (!clientReutilise) {
      // Pas de correspondance exacte : cree le client directement depuis
      // cette meme fenetre, via son raccourci integre "+ Créer un nouveau
      // client" (voir creerClientDepuisFormulaireEvenement) - le chemin
      // reellement emprunte par l'utilisateur. L'ancien chemin (fermer
      // cette fenetre, detour par l'ecran "Clients", rouvrir un evenement)
      // provoquait un dialogue fantome recidivant jamais rencontre par
      // l'utilisateur en usage normal.
      await creerClientDepuisFormulaireEvenement(page, demande);

      // Echec reel : une fois le client cree et enregistre, l'enchainement
      // ramene sur l'ecran general du Planning plutot que de rester dans
      // la fenetre d'evenement (qui se ferme entierement, pas seulement le
      // sous-dialogue client) - il faut donc rouvrir un formulaire
      // d'evenement avant de pouvoir re-chercher le client qui vient
      // d'etre cree.
      await allerAuPlanning(page);
      await ouvrirNouvelEvenement(page);
      const retrouve = await chercherEtSelectionnerClient(page, demande.nom);
      if (!retrouve) {
        const diagnostic = await capturerDiagnostic(page);
        throw new SynecEcritureError(`Client créé mais introuvable ensuite dans le sélecteur de l'événement. État final : ${diagnostic}`);
      }
    }

    await remplirEvenement(page, demande);

    await marquerDemandeInterventionSaisie(prisma, demandeId);
    await logEvenement(prisma, {
      evenement: "synec_ecriture",
      action: `Envoi vers Synec de la demande de ${demande.nom}`,
      resultat: clientReutilise ? "Client existant réutilisé, événement créé." : "Nouveau client créé, événement créé.",
    });

    return { clientReutilise };
  } catch (err) {
    await page?.screenshot({ path: CHEMIN_CAPTURE_ECHEC, fullPage: true }).catch(() => {});
    await logEvenement(prisma, {
      evenement: "synec_ecriture_erreur",
      action: `Envoi vers Synec de la demande ${demandeId}`,
      resultat: `Échec : ${(err as Error).message}`,
    }).catch(() => {});
    await alerterEchecParMail(prisma, demande, (err as Error).message).catch(() => {});
    throw err;
  } finally {
    await navigateur.close();
  }
}

/**
 * Prévient par e-mail (capture d'écran du blocage jointe) quand l'envoi
 * échoue : demande explicite de l'utilisateur ("tu peux pas créer un
 * système qui... te remonte les défauts"). Même mécanisme que le
 * compte-rendu du standard téléphonique (finaliserAppel dans
 * standardTelephonique.ts) - une boîte Gmail déjà connectée, jamais
 * d'échec silencieux qui laisserait la demande bloquée sans que personne
 * ne le sache. Un échec d'envoi de CET e-mail n'aggrave jamais l'erreur
 * d'origine (appelé avec .catch(() => {}) par l'appelant).
 */
async function alerterEchecParMail(prisma: PrismaClient, demande: DemandeIntervention, messageErreur: string): Promise<void> {
  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) return;
  const { gmail, connexion } = connexionGmail;

  const capture = await readFile(CHEMIN_CAPTURE_ECHEC).catch(() => null);
  const composer = new MailComposer({
    to: process.env.TELEPHONE_EMAIL_NOTIFICATION || connexion.compteEmail,
    subject: `Échec de l'envoi Synec — ${demande.nom}`,
    text: [
      `L'envoi automatique vers Synec de la demande de ${demande.nom} a échoué.`,
      `Elle reste dans la file "à saisir" (rien n'a été modifié côté Synec) : à saisir à la main si besoin, ou réessayer après correction.`,
      "",
      `Détail technique : ${messageErreur}`,
    ].join("\n"),
    attachments: capture ? [{ filename: "blocage-synec.png", content: capture, contentType: "image/png" }] : [],
  });
  const message = await composer.compile().build();
  await gmail.users.messages.send({ userId: "me", requestBody: { raw: message.toString("base64url") } });
}
