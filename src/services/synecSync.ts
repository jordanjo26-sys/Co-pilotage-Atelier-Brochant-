import { chromium } from "playwright";
import { readFile } from "fs/promises";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { logEvenement } from "./journalService";
import { receiveCsv } from "./importService";

// Capture d'ecran du dernier echec, servie par GET /api/synec/capture-echec
// (meme protection globale par mot de passe que le reste du site) : un
// diagnostic textuel seul (voir capturerDiagnostic) a montre ses limites
// apres plusieurs essais infructueux a deviner la structure HTML reelle de
// Synec sans jamais la voir - une image tranche instantanement.
export const CHEMIN_CAPTURE_ECHEC = path.join(process.cwd(), "synec-derniere-capture.png");

/**
 * Récupération automatique des factures Synec (Phase 11, demande explicite
 * de l'utilisateur de connecter "le pack office Synec" une fois la refonte
 * de l'interface livrée). Synec ne propose aucune API (confirmé deux fois
 * par l'utilisateur) : la seule voie d'automatisation possible est de
 * piloter un navigateur headless qui se connecte au site avec un compte
 * dédié, exactement comme un utilisateur le ferait à la main, puis
 * récupère le même export CSV qu'un dépôt manuel.
 *
 * Reprend ensuite exactement le pipeline d'import CSV existant
 * (`receiveCsv`) : aucune logique de détection/normalisation/déduplication
 * dupliquée, le fichier récupéré automatiquement est traité à l'identique
 * d'un fichier déposé à la main (même déduplication par hash de fichier et
 * par référence de facture).
 *
 * Fragile par nature (contrairement à une vraie API) : toute évolution de
 * l'interface Synec peut casser cette automatisation. Chaque étape est
 * individuellement journalisée en cas d'échec pour permettre un diagnostic
 * rapide depuis l'onglet "Système" de l'application, sans accès SSH.
 */

export interface ResultatSyncSynec {
  fichierNom: string;
  nbNouveaux: number;
  nbDoublons: number;
  nbErreurs: number;
}

export function synecEstConfigure(): boolean {
  return Boolean(process.env.SYNEC_URL && process.env.SYNEC_IDENTIFIANT && process.env.SYNEC_MOT_DE_PASSE);
}

/**
 * À la différence de Gmail/Stripe (un simple appel API suffit à vérifier un
 * jeton), une vérification "en direct" de Synec impliquerait de lancer un
 * navigateur complet et de s'y connecter — bien trop coûteux pour être
 * appelé à chaque chargement du tableau de bord (toutes les 2 minutes avec
 * le rafraîchissement automatique). Le statut reflète donc le résultat de
 * la dernière tentative réelle de synchronisation (programmée ou
 * manuelle), consultée dans le journal — même principe que
 * `derniereSynchroStripe`, mais sans appel réseau supplémentaire.
 */
export async function verifierConnexionSynec(prisma: PrismaClient): Promise<{ ok: true } | { ok: false; motif: string }> {
  if (!synecEstConfigure()) return { ok: false, motif: "Identifiants Synec non configurés." };

  const dernierEvenement = await prisma.journalEvenement.findFirst({
    where: { evenement: { in: ["synec_sync", "synec_sync_erreur"] } },
    orderBy: { horodatage: "desc" },
  });

  if (dernierEvenement?.evenement === "synec_sync_erreur") {
    return { ok: false, motif: dernierEvenement.resultat || "Dernière synchronisation Synec en échec." };
  }
  return { ok: true };
}

function obtenirIdentifiants(): { url: string; identifiant: string; motDePasse: string } {
  const url = process.env.SYNEC_URL;
  const identifiant = process.env.SYNEC_IDENTIFIANT;
  const motDePasse = process.env.SYNEC_MOT_DE_PASSE;
  if (!url || !identifiant || !motDePasse) {
    throw new Error("Identifiants Synec non configurés (SYNEC_URL/SYNEC_IDENTIFIANT/SYNEC_MOT_DE_PASSE).");
  }
  return { url, identifiant, motDePasse };
}

/**
 * Connexion au formulaire Synec (identifiant/mot de passe, pas de 2FA sur
 * le compte dédié - confirmé par l'utilisateur). Le bouton de soumission
 * reste `disabled` tant que le script client de Synec (chiffrement du mot
 * de passe côté navigateur avant envoi, observé via sodium.js/crypto.js
 * sur la page de connexion publique) n'a pas validé la saisie : on attend
 * qu'il se déverrouille plutôt que de cliquer immédiatement après avoir
 * rempli les champs.
 */
async function seConnecter(page: import("playwright").Page, identifiant: string, motDePasse: string): Promise<void> {
  await page.fill('input[name="login"]', identifiant);
  await page.fill('input[name="password"]', motDePasse);

  const boutonConnexion = page.locator('button[type="submit"]').first();
  await boutonConnexion.waitFor({ state: "visible", timeout: 15000 });
  // Exprime en chaine (evaluee cote navigateur par Playwright) plutot qu'en
  // fonction TypeScript : ce code ne s'execute jamais dans ce process Node
  // (pas de lib DOM dans tsconfig) mais dans la page, une fois serialise.
  await page
    .waitForFunction(
      "(() => { const b = document.querySelector('button[type=\"submit\"]'); return b && !b.hasAttribute('disabled'); })()",
      undefined,
      { timeout: 15000 }
    )
    .catch(() => {
      // Si le bouton ne se deverrouille jamais (page differente de celle
      // inspectee), on tente quand meme le clic : Playwright echouera alors
      // avec un message explicite plutot que de bloquer indefiniment.
    });

  await Promise.all([page.waitForLoadState("networkidle"), boutonConnexion.click()]);

  const erreurLogin = page.locator("#login_error, #password_error").first();
  if (await erreurLogin.isVisible().catch(() => false)) {
    const texte = (await erreurLogin.textContent().catch(() => null))?.trim();
    throw new Error(`Connexion Synec refusée${texte ? " : " + texte : " (identifiant ou mot de passe incorrect)"}.`);
  }
}

/**
 * Capture un etat de la page (URL, titre, extrait du texte visible) pour
 * diagnostic en cas d'echec de navigation - sans ca, un echec ne dit que
 * "Factures introuvable" sans jamais montrer CE QUI a ete charge a la
 * place (page de connexion encore affichee, erreur Synec, tableau de bord
 * different de celui attendu...), obligeant a deviner a l'aveugle a
 * chaque nouvel echec. Le texte est tronque et les espaces/retours a la
 * ligne repetes compresses pour rester lisible dans la carte Synec de
 * l'interface.
 */
async function capturerDiagnostic(page: import("playwright").Page): Promise<string> {
  const url = page.url();
  const titre = await page.title().catch(() => "?");
  const texte = await page
    .locator("body")
    .innerText()
    .then((t) => t.replace(/\s+/g, " ").trim().slice(0, 400))
    .catch(() => "(texte illisible)");
  return `URL actuelle : ${url} — titre : "${titre}" — texte visible : "${texte}"`;
}

/**
 * Liste tous les elements ressemblant a un bouton/lien de menu (texte,
 * classes ou aria-label evoquant "toggle"/"navbar"/"menu"/"sidebar"/
 * "drawer"/"hamburger") avec leur position et visibilite reelles.
 *
 * Remplace le pari sur un seul selecteur texte/role : un echec reel a
 * montre qu'un clic "reussi" sur l'element trouve par
 * `getByRole("button", { name: /toggle navigation/i })` ouvre un menu
 * DIFFERENT de celui attendu (confirme par une video de l'utilisateur,
 * qui clique bien le meme bouton ☰ visuellement mais obtient le bon
 * resultat) - signe quasi certain qu'il existe PLUSIEURS elements
 * candidats sur la page et que le mauvais a ete cible jusqu'ici. Cette
 * liste permet de voir tous les candidats reels au lieu d'en deviner un
 * seul a l'aveugle.
 */
async function listerCandidatsMenu(page: import("playwright").Page): Promise<string> {
  const resultat = await page
    .evaluate(
      `(() => {
        const selecteur = 'button, a, [role="button"], [class*="toggl" i], [class*="navbar" i], [class*="menu" i], [class*="sidebar" i], [class*="drawer" i], [class*="hamburger" i], [aria-label*="menu" i], [aria-label*="toggl" i]';
        const els = Array.from(document.querySelectorAll(selecteur)).slice(0, 15);
        return els.map((el, i) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          const visible = r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
          const texte = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30);
          const classes = typeof el.className === 'string' ? el.className.slice(0, 60) : '';
          const aria = el.getAttribute('aria-label') || '';
          return i + ':' + el.tagName + (el.id ? '#' + el.id : '') + (classes ? '.' + classes.replace(/ /g, '.') : '') + (aria ? ' aria=\"' + aria + '\"' : '') + (texte ? ' texte=\"' + texte + '\"' : '') + ' pos=(' + Math.round(r.x) + ',' + Math.round(r.y) + ') taille=' + Math.round(r.width) + 'x' + Math.round(r.height) + ' visible=' + visible;
        }).join(' | ');
      })()`
    )
    .catch((err) => `(introspection impossible : ${(err as Error).message})`);
  return `Candidats menu : ${resultat}`;
}

/**
 * Atteint l'écran "Factures". Chemin confirmé en examinant image par image
 * une vidéo fournie par l'utilisateur :
 * 0. Juste après connexion : "Interface de gestion" / "Collaborateur sur
 *    les organisations" (le compte a accès à "Atelier Brochant" ET
 *    "Groupe Belle Énergie").
 * 1. Menu ☰ cliqué DIRECTEMENT SUR CET ÉCRAN, sans jamais cliquer sur une
 *    organisation au préalable - confirmé par la vidéo (le logo "GBE" de
 *    l'autre organisation reste visible en arrière-plan pendant que le
 *    tiroir s'ouvre). Le tiroir contient déjà "Atelier Brochant"
 *    présélectionné.
 * 2. "Facturation" (dans le tiroir) → déplie un sous-menu (Clients,
 *    Planning, Abonnements, Devis, **Factures**, Produits, Documents,
 *    Marques) ; n'navigue nulle part en lui-même, juste un accordéon.
 * 3. "Factures" (dans ce sous-menu) → écran des factures recherché.
 *
 * Erreur commise dans une version précédente : cliquer sur "Atelier
 * Brochant" AVANT d'ouvrir le menu, pensant que c'était un préalable
 * nécessaire. Ça envoie en réalité vers une page de "Tableau de bord"
 * différente (framework AdminLTE), dont le menu ☰ n'ouvre qu'un tiroir
 * limité ("Accueil"/"Tableau de bord" seulement, jamais "Facturation") -
 * un tiroir sans rapport avec celui recherché. Le clic sur l'organisation
 * n'est donc tenté qu'en dernier recours, si le menu direct échoue.
 *
 * Une adresse directe (favori fourni par l'utilisateur) a aussi été
 * tentée : 404 dans une session fraîche, abandonnée (route accessible
 * seulement via la navigation interne de l'application).
 */
async function allerAuxFactures(page: import("playwright").Page): Promise<void> {
  // Recherche par TEXTE visible plutot que par role d'accessibilite
  // ("button"/"link") : constate en production que ce repere echouait en
  // permanence meme en etant sur la bonne page, "Export CSV" n'etant
  // vraisemblablement pas un <button> au sens strict (lien stylise ou
  // composant personnalise, invisible pour getByRole). Attend jusqu'a 5s
  // que le texte apparaisse plutot qu'un controle instantane : un rendu
  // cote client peut encore finir de s'afficher juste apres le networkidle.
  const dejaSurFactures = async () =>
    page
      .getByText(/export csv/i)
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);

  if (await dejaSurFactures()) return;

  const etapes: string[] = [];
  const essayerClic = async (motif: RegExp): Promise<boolean> => {
    const locator = page.getByText(motif).first();
    const visible = await locator
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (!visible) return false;
    await locator.click();
    await page.waitForTimeout(800); // laisse l'animation (tiroir/accordeon) se terminer
    return true;
  };

  // Ouvre le menu ☰ DIRECTEMENT sur la page actuelle (pas besoin de
  // selectionner une organisation au prealable - confirme par la video).
  // getByRole (pas getByText) pour ce bouton : "Toggle navigation" est tres
  // probablement un texte visuellement cache (accessibilite seule, pattern
  // Bootstrap classique, confirme sur la page de connexion publique de
  // Synec) a l'interieur du vrai bouton ☰.
  const ouvrirMenu = async (): Promise<boolean> => {
    const bouton = page.getByRole("button", { name: /toggle navigation/i }).or(page.locator(".navbar-toggler")).first();
    const visible = await bouton
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (!visible) return false;
    await bouton.click();
    await page.waitForTimeout(500);
    return page
      .getByText(/^facturation$/i)
      .first()
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
  };

  let menuOuvert = await ouvrirMenu();
  etapes.push(`menu_direct:${menuOuvert}`);

  // Repli : si le menu direct echoue, selectionner l'organisation "Atelier
  // Brochant" avant de reessayer - comportement observe sur un echec reel
  // ("ancienne" version de ce correctif), garde au cas ou l'ecran
  // intermediaire se comporte differemment un jour.
  if (!menuOuvert) {
    const lienOrganisation = page.getByText(/atelier brochant/i).first();
    if (await lienOrganisation.isVisible().catch(() => false)) {
      await lienOrganisation.click();
      await page.waitForLoadState("networkidle");
      menuOuvert = await ouvrirMenu();
      etapes.push(`menu_apres_organisation:${menuOuvert}`);
    }
  }

  const diagnosticApresMenu = menuOuvert ? await capturerDiagnostic(page) : null;
  const candidats = menuOuvert ? null : await listerCandidatsMenu(page);

  etapes.push(`facturation:${await essayerClic(/^facturation$/i)}`);
  etapes.push(`factures:${await essayerClic(/^factures$/i)}`);

  await page.waitForLoadState("networkidle");
  if (await dejaSurFactures()) return;

  const diagnostic = await capturerDiagnostic(page);
  throw new Error(
    `Écran "Factures" introuvable (étapes : ${etapes.join(", ")}).` +
      (candidats ? ` ${candidats}` : "") +
      (diagnosticApresMenu ? ` Juste après le clic sur le menu : ${diagnosticApresMenu}` : "") +
      ` État final : ${diagnostic}`
  );
}

/**
 * Réinitialise les filtres puis déclenche l'export CSV. Volontairement
 * SANS filtrer sur "facture non payée" : un menu déroulant personnalisé
 * (pas un <select> natif, vu sur les captures d'écran fournies) est plus
 * risqué à piloter sans avoir pu inspecter son HTML réel, alors que
 * `receiveCsv` sait déjà déterminer seul le statut payé/impayé de chaque
 * facture à partir de la colonne "règlements" de l'export - exporter la
 * totalité des factures a aussi l'avantage de mettre à jour le statut
 * d'une facture qui vient d'être payée, pas seulement de découvrir les
 * nouvelles factures impayées.
 */
async function exporterCsv(page: import("playwright").Page): Promise<{ nomFichier: string; buffer: Buffer }> {
  // Meme choix que dejaSurFactures() : texte visible plutot que role
  // d'accessibilite, plus fiable sans connaitre la structure HTML reelle.
  const boutonReset = page.getByText(/r[ée]initialiser tous les filtres/i).first();
  if (await boutonReset.isVisible().catch(() => false)) {
    await boutonReset.click();
    await page.waitForLoadState("networkidle");
  }

  const boutonExport = page.getByText(/export csv/i).first();
  const [telechargement] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    boutonExport.click(),
  ]);

  const chemin = await telechargement.path();
  if (!chemin) throw new Error("Échec du téléchargement de l'export CSV Synec.");
  const buffer = await readFile(chemin);
  const nomFichier = telechargement.suggestedFilename() || `synec_factures_${new Date().toISOString().slice(0, 10)}.csv`;
  return { nomFichier, buffer };
}

/**
 * Synchronise les factures Synec : connexion, navigation, export CSV, puis
 * traitement par le pipeline d'import existant. Toute étape en échec
 * interrompt la synchronisation (contrairement à la synchronisation Gmail
 * qui continue message par message) : il n'y a pas de résultat partiel
 * possible une fois la connexion ou la navigation en échec.
 */
export async function synchroniserSynec(prisma: PrismaClient): Promise<ResultatSyncSynec> {
  const { url, identifiant, motDePasse } = obtenirIdentifiants();

  const navigateur = await chromium.launch({ headless: true });
  let page: import("playwright").Page | undefined;
  try {
    // Largeur d'ecran de telephone (comme l'utilisateur, iPhone), PAS la
    // largeur de bureau par defaut de Playwright (1280x720) : plusieurs
    // echecs reels en production ont montre un clic "reussi" sur le bouton
    // de menu sans aucun effet visible ensuite - tres probablement parce
    // qu'a une largeur de bureau, Synec affiche son menu differemment (un
    // bouton "Toggle navigation" present mais sans action reelle a cette
    // largeur, pattern Bootstrap courant ou le menu replie n'existe qu'en
    // dessous d'un certain seuil de largeur). Cette largeur reproduit
    // exactement le contexte dans lequel la navigation manuelle de
    // l'utilisateur (vue par video) fonctionne reellement.
    page = await navigateur.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    await seConnecter(page, identifiant, motDePasse);
    await allerAuxFactures(page);
    const { nomFichier, buffer } = await exporterCsv(page);

    const resume = await receiveCsv(prisma, nomFichier, buffer);

    await logEvenement(prisma, {
      evenement: "synec_sync",
      action: "Synchronisation Synec (export automatique des factures)",
      resultat: `${resume.nbNouveaux} nouveau(x), ${resume.nbDoublons} doublon(s), ${resume.nbErreurs} erreur(s) (statut : ${resume.statut}).`,
    });

    return { fichierNom: nomFichier, nbNouveaux: resume.nbNouveaux, nbDoublons: resume.nbDoublons, nbErreurs: resume.nbErreurs };
  } catch (err) {
    // Capture d'ecran du dernier echec : un diagnostic textuel seul a deja
    // montre ses limites apres plusieurs essais infructueux (voir
    // CHEMIN_CAPTURE_ECHEC, servie par GET /api/synec/capture-echec).
    await page?.screenshot({ path: CHEMIN_CAPTURE_ECHEC, fullPage: true }).catch(() => {});
    await logEvenement(prisma, {
      evenement: "synec_sync_erreur",
      action: "Synchronisation Synec",
      resultat: `Échec : ${(err as Error).message}`,
    }).catch(() => {});
    throw err;
  } finally {
    await navigateur.close();
  }
}

/** Date de la dernière synchronisation Synec réussie, pour affichage dans l'interface. */
export async function derniereSynchroSynec(prisma: PrismaClient): Promise<Date | null> {
  const dernier = await prisma.journalEvenement.findFirst({
    where: { evenement: "synec_sync" },
    orderBy: { horodatage: "desc" },
  });
  return dernier?.horodatage || null;
}
