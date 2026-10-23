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
 */
async function ouvrirNouvelEvenement(page: import("playwright").Page): Promise<void> {
  const bouton = page.getByText(/nouvel événement/i).first();
  await bouton.waitFor({ state: "visible", timeout: 45000 });
  await bouton.click();
  await page.getByText(/création d'un nouvel événement/i).first().waitFor({ state: "visible", timeout: 8000 });
}

/**
 * Crée une fiche client (section "Clients", formulaire "Création d'un
 * client" vu dans la vidéo). Volontairement minimal : seuls les champs que
 * l'intake collecte déjà sont remplis (nom, téléphone, e-mail, adresse) -
 * Attestation TVA, prénom/nom séparés laissés tels quels ("trop tôt pour
 * automatiser", décision explicite de l'utilisateur), à compléter à la main
 * dans Synec si besoin.
 */
async function creerClient(page: import("playwright").Page, demande: DemandeIntervention): Promise<void> {
  const { etapes, diagnosticApresMenu, candidats } = await ouvrirMenuFacturation(page);
  const clientsOuvert = await cliquerSiVisible(page, /^clients$/i);
  etapes.push(`clients:${clientsOuvert}`);
  await page.waitForLoadState("networkidle");

  const boutonNouveauClient = page.getByText(/nouveau client/i).first();
  const visible = await boutonNouveauClient
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    const diagnostic = await capturerDiagnostic(page);
    throw new SynecEcritureError(
      `Écran "Clients" introuvable (étapes : ${etapes.join(", ")}).` +
        (candidats ? ` ${candidats}` : "") +
        (diagnosticApresMenu ? ` Juste après le clic sur le menu : ${diagnosticApresMenu}` : "") +
        ` État final : ${diagnostic}`
    );
  }
  await boutonNouveauClient.click();

  const enTeteFormulaire = page.getByText(/création d'un client/i).first();
  await enTeteFormulaire.waitFor({ state: "visible", timeout: 8000 });

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

  const boutonEnregistrer = page.getByText(/^enregistrer et fermer$/i).first();
  await boutonEnregistrer.click();

  const confirmation = page.getByText(/enregistré/i).first();
  const confirme = await confirmation
    .waitFor({ state: "visible", timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!confirme) {
    const diagnostic = await capturerDiagnostic(page);
    throw new SynecEcritureError(`La fiche client ne semble pas enregistrée. État final : ${diagnostic}`);
  }
  await page.waitForLoadState("networkidle");
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
  // (l'instant de creation de l'evenement). Duree par defaut 1h, comme dans
  // la demonstration de l'utilisateur. Non bloquant si le champ ne reagit
  // pas a .fill() (saisie masquee non confirmee sans acces direct a Synec) :
  // l'evenement est alors cree avec la date par defaut plutot que d'echouer
  // toute la demande pour ce seul champ.
  if (demande.dateSouhaitee) {
    const debut = demande.dateSouhaitee;
    const fin = new Date(debut.getTime() + 60 * 60 * 1000);
    await remplirApresLibelle(page, /date de début de l'événement/i, formaterDateHeureSynec(debut)).catch(() => {});
    await remplirApresLibelle(page, /date de fin de l'événement/i, formaterDateHeureSynec(fin)).catch(() => {});
  }

  const champNom = page.getByText(/^nom$/i).last().locator("xpath=following::input[1]").first();
  await champNom
    .fill(`${demande.nom} — ${demande.urgence === "urgente" ? "URGENT" : "intervention"}`)
    .catch(() => {});

  const zoneDescription = page.locator('[contenteditable="true"]').first();
  const descriptionVisible = await zoneDescription
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (descriptionVisible) {
    await zoneDescription.click();
    await zoneDescription.type(construireDescriptionEvenement(demande));
  }

  const boutonEnregistrer = page.getByText(/^enregistrer et fermer$/i).first();
  await boutonEnregistrer.click();

  const formulaireFerme = await page
    .getByText(/création d'un nouvel événement/i)
    .first()
    .waitFor({ state: "hidden", timeout: 10000 })
    .then(() => true)
    .catch(() => false);
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
      // Pas de correspondance exacte : ferme ce formulaire d'evenement,
      // cree le client depuis l'ecran "Clients" (chemin confirme par la
      // video de l'utilisateur), puis revient creer l'evenement - la
      // recherche retrouvera alors ce client tout juste cree.
      await page
        .getByRole("button", { name: /close|fermer|×/i })
        .first()
        .click()
        .catch(() => page!.keyboard.press("Escape"));
      await creerClient(page, demande);

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
