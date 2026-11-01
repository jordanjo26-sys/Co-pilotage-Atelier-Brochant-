import { chromium } from "playwright";
import path from "path";
import { PrismaClient } from "@prisma/client";
import {
  capturerDiagnostic,
  cliquerSiVisible,
  fermerDialoguesResiduels,
  obtenirIdentifiants,
  ouvrirMenuFacturation,
  seConnecter,
} from "./synecSync";
import {
  chercherEtSelectionnerClient,
  remplirApresLibelle,
  remplirDescriptionEvenement,
  selectionnerOptionInsensibleCasse,
} from "./synecEcriture";
import { logEvenement } from "./journalService";

/**
 * Création de devis directement dans Synec (écriture, même famille que
 * synecEcriture.ts pour le planning/client - PAS une API, Synec n'en
 * propose aucune, voir synecSync.ts). Demande explicite de l'utilisateur
 * après avoir constaté que Morgane ne pouvait que générer un PDF de devis
 * sans le déposer réellement dans Synec.
 *
 * Contrairement à la création de client/événement (construite à partir
 * d'une vidéo de démonstration fournie par l'utilisateur), aucune capture
 * de l'écran "Devis" n'était disponible : `explorerFormulaireDevis` sert
 * donc d'abord à observer la structure réelle du formulaire (lecture
 * seule, ne soumet jamais rien) avant d'écrire la fonction de création
 * elle-même - même principe que pour Dext (section 14, jamais deviner la
 * structure d'un tiers sans l'avoir vue).
 */

export class SynecDevisError extends Error {}

const CHEMIN_CAPTURE_EXPLORATION = path.join(process.cwd(), "synec-exploration-devis.png");

/**
 * Atteint l'écran "Devis" (même famille de navigation que allerAuPlanning/
 * allerAuxClients dans synecEcriture.ts - menu ☰ → Facturation → Devis,
 * sous-menu confirmé par la vidéo utilisateur ayant servi à construire
 * ouvrirMenuFacturation : "Clients, Planning, Abonnements, Devis,
 * Factures...").
 */
async function allerAuxDevis(page: import("playwright").Page): Promise<string[]> {
  const dejaSurDevis = async () =>
    page
      .getByText(/nouveau devis/i)
      .first()
      .waitFor({ state: "visible", timeout: 10000 })
      .then(() => true)
      .catch(() => false);

  if (await dejaSurDevis()) return ["deja_sur_devis:true"];

  const { etapes, diagnosticApresMenu, candidats } = await ouvrirMenuFacturation(page);
  etapes.push(`devis:${await cliquerSiVisible(page, /^devis$/i)}`);

  await page.waitForLoadState("networkidle");
  if (await dejaSurDevis()) return etapes;

  const diagnostic = await capturerDiagnostic(page);
  throw new SynecDevisError(
    `Écran "Devis" introuvable (étapes : ${etapes.join(", ")}).` +
      (candidats ? ` ${candidats}` : "") +
      (diagnosticApresMenu ? ` Juste après le clic sur le menu : ${diagnosticApresMenu}` : "") +
      ` État final : ${diagnostic}`
  );
}

/**
 * Dump de tous les champs (label le plus proche + type/name/id) et boutons
 * visibles de la page - diagnostic en texte, en plus de la capture d'écran
 * (CHEMIN_CAPTURE_EXPLORATION), pour voir précisément quels libellés/menus
 * utiliser dans la vraie fonction de création plutôt que de deviner.
 */
async function dumperFormulaire(page: import("playwright").Page): Promise<string> {
  return page.evaluate(`(() => {
    const champLisible = (el) => {
      let label = null;
      if (el.id) {
        const l = document.querySelector('label[for="' + el.id + '"]');
        if (l) label = l.textContent.trim();
      }
      if (!label) {
        let n = el.previousElementSibling;
        let essais = 0;
        while (n && essais < 3 && !label) {
          const t = (n.textContent || '').trim();
          if (t && t.length < 60) label = t;
          n = n.previousElementSibling;
          essais++;
        }
      }
      if (!label) {
        const parentLabel = el.closest('label');
        if (parentLabel) label = parentLabel.textContent.trim();
      }
      return label || '(sans libellé proche)';
    };
    const champs = Array.from(document.querySelectorAll('input, select, textarea')).map((el, i) => {
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0;
      const base = i + ':' + el.tagName + (el.type ? '[type=' + el.type + ']' : '') + (el.name ? ' name="' + el.name + '"' : '') + (el.id ? ' id="' + el.id + '"' : '') + (el.placeholder ? ' placeholder="' + el.placeholder + '"' : '') + ' label="' + champLisible(el) + '" visible=' + visible;
      if (el.tagName === 'SELECT') {
        const options = Array.from(el.options).map((o) => o.text).join('|');
        return base + ' options=[' + options + ']';
      }
      return base;
    }).join('\\n');
    const boutons = Array.from(document.querySelectorAll('button, [role="button"], a.btn, .select2-selection')).map((el, i) => {
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0;
      const texte = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 50);
      return i + ':' + el.tagName + (el.className && typeof el.className === 'string' ? '.' + el.className.slice(0,40).replace(/ /g,'.') : '') + ' texte="' + texte + '" visible=' + visible;
    }).filter((t) => t.includes('texte="') && !t.includes('texte=""')).join('\\n');
    return 'CHAMPS:\\n' + champs + '\\n\\nBOUTONS:\\n' + boutons;
  })()`) as Promise<string>;
}

/**
 * Exploration en lecture seule du formulaire "Nouveau devis" : ne clique
 * que sur des éléments de navigation (menu, bouton "Nouveau devis"), ne
 * remplit ni ne soumet jamais rien. Retourne un dump texte des champs/
 * boutons trouvés et enregistre une capture d'écran complète
 * (CHEMIN_CAPTURE_EXPLORATION, servie par GET /api/synec/exploration-devis).
 */
export async function explorerFormulaireDevis(_prisma: PrismaClient): Promise<string> {
  const { url, identifiant, motDePasse } = obtenirIdentifiants();
  const navigateur = await chromium.launch({ headless: true });
  let page: import("playwright").Page | undefined;
  try {
    page = await navigateur.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await seConnecter(page, identifiant, motDePasse);

    const etapesDevis = await allerAuxDevis(page);
    const dumpListeDevis = await dumperFormulaire(page);

    await fermerDialoguesResiduels(page);
    const boutonNouveauDevis = page.getByText(/nouveau devis/i).first();
    await boutonNouveauDevis.waitFor({ state: "visible", timeout: 10000 });
    await boutonNouveauDevis.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    const dumpFormulaireCreation = await dumperFormulaire(page);
    await page.screenshot({ path: CHEMIN_CAPTURE_EXPLORATION, fullPage: true }).catch(() => {});
    const diagnostic = await capturerDiagnostic(page);

    return [
      `Étapes navigation : ${etapesDevis.join(", ")}`,
      `--- Écran liste des devis ---`,
      dumpListeDevis,
      `--- Après clic "Nouveau devis" ---`,
      diagnostic,
      dumpFormulaireCreation,
    ].join("\n\n");
  } catch (err) {
    await page?.screenshot({ path: CHEMIN_CAPTURE_EXPLORATION, fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await navigateur.close();
  }
}

/**
 * Dump de tous les boutons/liens de la page, ICONES SEULES INCLUSES (sans
 * texte visible - exclues de dumperFormulaire ci-dessus) : classe complète,
 * title, aria-label, et classe du premier enfant <i>/<svg> le cas échéant -
 * nécessaire pour identifier de façon fiable un bouton-icône (ex. "Produits
 * du devis") qu'aucun texte ne permet de cibler par getByText.
 */
async function dumperBoutonsIcones(page: import("playwright").Page): Promise<string> {
  return page.evaluate(`(() => {
    const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return els.map((el, i) => {
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0;
      if (!visible) return null;
      const texte = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30);
      const classes = typeof el.className === 'string' ? el.className : '';
      const title = el.getAttribute('title') || '';
      const aria = el.getAttribute('aria-label') || '';
      const enfantIcone = el.querySelector('i, svg');
      const classeIcone = enfantIcone && typeof enfantIcone.className === 'string' ? enfantIcone.className : (enfantIcone ? String(enfantIcone.className) : '');
      return i + ':' + el.tagName + '.' + classes.slice(0,70).replace(/ /g,'.') + (title ? ' title="'+title+'"' : '') + (aria ? ' aria="'+aria+'"' : '') + (classeIcone ? ' icone="'+classeIcone.slice(0,50)+'"' : '') + (texte ? ' texte="'+texte+'"' : ' texte=(vide)') + ' pos=(' + Math.round(r.x) + ',' + Math.round(r.y) + ')';
    }).filter(Boolean).join('\\n');
  })()`) as Promise<string>;
}

/**
 * Exploration en lecture seule (aucune création, aucune sauvegarde) du
 * detail d'un devis EXISTANT : clique sur sa ligne pour deplier les
 * icones d'action, puis sur l'icone "Produits du devis" (reperee parmi
 * les icones dumpees) pour reveler la section d'ajout de produit - sert a
 * identifier un selecteur fiable pour cette icone (sans texte visible,
 * donc invisible pour dumperFormulaire) avant d'ecrire la creation reelle.
 */
export async function explorerDetailDevis(_prisma: PrismaClient, nomClientDevisExistant: string): Promise<string> {
  const { url, identifiant, motDePasse } = obtenirIdentifiants();
  const navigateur = await chromium.launch({ headless: true });
  let page: import("playwright").Page | undefined;
  try {
    page = await navigateur.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await seConnecter(page, identifiant, motDePasse);
    await allerAuxDevis(page);

    let ligne: import("playwright").Locator | null = null;
    const candidats = page.getByText(nomClientDevisExistant, { exact: false });
    for (let essai = 0; essai < 10 && !ligne; essai++) {
      const nombre = await candidats.count().catch(() => 0);
      for (let i = 0; i < nombre; i++) {
        if (await candidats.nth(i).isVisible().catch(() => false)) {
          ligne = candidats.nth(i);
          break;
        }
      }
      if (!ligne) await page.waitForTimeout(1000);
    }
    if (!ligne) throw new SynecDevisError(`Devis pour "${nomClientDevisExistant}" introuvable dans la liste.`);
    await ligne.click();
    await page.waitForTimeout(1000);

    const boutonsApresExpansion = await dumperBoutonsIcones(page);

    await page.screenshot({ path: CHEMIN_CAPTURE_EXPLORATION, fullPage: true }).catch(() => {});

    return [`--- Boutons/icônes après clic sur la ligne "${nomClientDevisExistant}" ---`, boutonsApresExpansion].join("\n\n");
  } catch (err) {
    await page?.screenshot({ path: CHEMIN_CAPTURE_EXPLORATION, fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await navigateur.close();
  }
}

// ---------------------------------------------------------------------
// Création réelle d'un devis (écriture) - construite à partir de la vidéo
// fournie par l'utilisateur (création du devis "Urbaine" avec deux
// lignes "Robinetterie"/"Main d'œuvre") et des deux explorations en
// lecture seule ci-dessus (structure du formulaire + sélecteur de
// l'icône "Produits", sans texte visible donc invisible à un simple
// getByText).
// ---------------------------------------------------------------------

export interface LigneDevis {
  nom: string;
  description?: string;
  /** Par défaut 1 - laissé intact sur Synec (pas de saisie) pour éviter le
   * sélecteur "-/+" non confirmé en lecture quand la quantité est 1. */
  quantite?: number;
  prixHT: number;
  /** Par défaut "non_defini" (défaut Synec lui-même, jamais deviné). */
  tva?: "20" | "10" | "5.5" | "2.1" | "8.5" | "non_applicable" | "non_defini";
}

export interface ParametresDevis {
  clientNom: string;
  /** Par défaut "Atelier Brochant" (marque très majoritaire sur les devis existants). */
  marque?: "Atelier Brochant" | "France Degorgement";
  validiteJours?: number;
  acompteDemandeEuros?: number;
  heureArrivee?: string;
  signataire?: string;
  noteInternePrimaire?: string;
  noteInterneSecondaire?: string;
  lignes: LigneDevis[];
}

export interface ResultatCreationDevis {
  numeroDevis: string | null;
  totalHT: string | null;
  totalTTC: string | null;
}

const LIBELLES_TVA: Record<NonNullable<LigneDevis["tva"]>, string> = {
  "20": "TVA 20%",
  "10": "TVA 10%",
  "5.5": "TVA 5,5%",
  "2.1": "TVA 2,1%",
  "8.5": "TVA 8,5%",
  non_applicable: "TVA non applicable",
  non_defini: "Non défini",
};

const LIBELLES_MARQUE: Record<NonNullable<ParametresDevis["marque"]>, string> = {
  "Atelier Brochant": "#1 Atelier Brochant",
  "France Degorgement": "#3 France Degorgement",
};

function formaterMontantFr(montant: number): string {
  return Number.isInteger(montant) ? String(montant) : montant.toFixed(2).replace(".", ",");
}

function analyserNombreFr(texte: string | null): number | null {
  if (!texte) return null;
  const nettoye = texte.replace(/[^\d,.-]/g, "").replace(",", ".");
  const n = Number(nettoye);
  return Number.isFinite(n) ? n : null;
}

/**
 * Remplit un champ texte/nombre après son libellé puis vérifie que la
 * valeur relue (tolérante au format FR, cf. analyserNombreFr) correspond
 * bien à celle demandée - même principe que la vérification de date dans
 * synecEcriture.ts (remplirEvenement) : un échec silencieux sur un champ
 * financier serait bien pire qu'une erreur explicite qui bloque tout.
 */
async function remplirEtVerifierMontant(page: import("playwright").Page, libelle: RegExp, montant: number): Promise<void> {
  const texteAEnvoyer = formaterMontantFr(montant);
  const label = page.getByText(libelle).first();
  await label.waitFor({ state: "visible", timeout: 5000 });
  const champ = label.locator("xpath=following::input[1]").first();
  await champ.click();
  await champ.press("Control+A").catch(() => {});
  await champ.press("Backspace").catch(() => {});
  await champ.pressSequentially(texteAEnvoyer, { delay: 15 });
  await champ.press("Tab").catch(() => {});

  const relu = analyserNombreFr(await champ.inputValue().catch(() => null));
  if (relu === null || Math.abs(relu - montant) > 0.01) {
    throw new SynecDevisError(`Le champ correspondant à /${libelle.source}/ contient "${relu}" au lieu de ${montant} attendu.`);
  }
}

/**
 * Clique "Enregistrer et fermer" - bouton partagé par toutes les modales
 * de ce type dans Synec (création devis, ajout produit...), identifié par
 * sa classe propre .then-close (voir dump CHAMPS/BOUTONS de
 * explorerFormulaireDevis) plutôt que par son texte : la modale partage
 * son conteneur avec un bouton "Enregistrer" seul (sans .then-close, qui
 * laisse la modale ouverte) - cibler par texte risquerait de tomber sur
 * l'un ou l'autre selon l'ordre dans le DOM.
 */
async function cliquerEnregistrerEtFermer(page: import("playwright").Page): Promise<void> {
  const bouton = page.locator("button.modal-save.then-close, a.modal-save.then-close").first();
  await bouton.waitFor({ state: "visible", timeout: 8000 });

  let essai = 0;
  let clique = false;
  let dernierEchec: Error | undefined;
  while (!clique && essai < 4) {
    essai++;
    clique = await bouton
      .click({ force: true, timeout: 6000 })
      .then(() => true)
      .catch((err) => {
        dernierEchec = err as Error;
        return false;
      });
    if (!clique) await page.waitForTimeout(1500);
  }
  if (!clique) throw new SynecDevisError(`Clic "Enregistrer et fermer" impossible après 4 essais : ${dernierEchec?.message}`);
  await page.waitForLoadState("networkidle").catch(() => {});
}

/**
 * Remplit et enregistre l'en-tête du devis (formulaire "Création d'un
 * devis", ouvert depuis "Nouveau devis") - marque, client (select2, même
 * widget que le champ "Client" de synecEcriture.ts, libellé différent
 * "Client à facturer"), puis les champs optionnels confirmés par la vidéo
 * utilisateur. Aucune création automatique de client ici (contrairement à
 * la demande d'intervention) : si le client n'existe pas, erreur
 * explicite plutôt que de deviner un chemin de création non filmé pour ce
 * formulaire précis.
 */
async function remplirEtEnregistrerEnTeteDevis(page: import("playwright").Page, params: ParametresDevis): Promise<void> {
  await fermerDialoguesResiduels(page);
  const boutonNouveauDevis = page.getByText(/nouveau devis/i).first();
  await boutonNouveauDevis.waitFor({ state: "visible", timeout: 10000 });
  await boutonNouveauDevis.click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByText(/création d'un devis/i).first().waitFor({ state: "visible", timeout: 8000 });

  const marque = params.marque ?? "Atelier Brochant";
  const selectMarque = page.locator('select[name="orm_id_billing_brand"]');
  const marqueConfirmee = await selectionnerOptionInsensibleCasse(selectMarque, LIBELLES_MARQUE[marque]).catch(() => null);
  if (!marqueConfirmee) {
    const diagnostic = await capturerDiagnostic(page);
    throw new SynecDevisError(`Impossible de sélectionner la marque "${marque}". État final : ${diagnostic}`);
  }

  const clientTrouve = await chercherEtSelectionnerClient(page, params.clientNom, /client à facturer/i);
  if (!clientTrouve) {
    throw new SynecDevisError(
      `Client "${params.clientNom}" introuvable dans Synec (recherche exacte par nom). Créez-le d'abord (onglet Clients) : la création automatique de client n'est pas prise en charge pour les devis.`
    );
  }

  if (params.validiteJours != null) {
    await remplirApresLibelle(page, /nombre de jours de validité/i, String(params.validiteJours)).catch(() => {});
  }
  if (params.acompteDemandeEuros != null) {
    await remplirApresLibelle(page, /acompte demandé/i, formaterMontantFr(params.acompteDemandeEuros)).catch(() => {});
  }
  if (params.heureArrivee) {
    await remplirApresLibelle(page, /heure d'arrivée/i, params.heureArrivee).catch(() => {});
  }
  if (params.signataire) {
    await remplirApresLibelle(page, /signataire/i, params.signataire).catch(() => {});
  }
  if (params.noteInternePrimaire) {
    await remplirApresLibelle(page, /note interne primaire/i, params.noteInternePrimaire).catch(() => {});
  }
  if (params.noteInterneSecondaire) {
    await remplirApresLibelle(page, /note interne secondaire/i, params.noteInterneSecondaire).catch(() => {});
  }

  await cliquerEnregistrerEtFermer(page);
}

/**
 * Retrouve la ligne du devis tout juste créé dans la liste (rechargée
 * après l'enregistrement de l'en-tête) - par nom de client, même limite
 * assumée qu'ailleurs dans ce fichier pour les clients existants
 * (rattachement par texte, pas d'identifiant direct disponible côté
 * client de cette automatisation).
 */
async function trouverLigneDevisParClient(page: import("playwright").Page, nomClient: string): Promise<import("playwright").Locator> {
  await page.waitForLoadState("networkidle").catch(() => {});
  let ligne: import("playwright").Locator | null = null;
  const candidats = page.getByText(nomClient, { exact: false });
  for (let essai = 0; essai < 15 && !ligne; essai++) {
    const nombre = await candidats.count().catch(() => 0);
    for (let i = 0; i < nombre; i++) {
      if (await candidats.nth(i).isVisible().catch(() => false)) {
        ligne = candidats.nth(i);
        break;
      }
    }
    if (!ligne) await page.waitForTimeout(1000);
  }
  if (!ligne) {
    const diagnostic = await capturerDiagnostic(page);
    throw new SynecDevisError(`Devis créé mais introuvable ensuite dans la liste pour "${nomClient}". État final : ${diagnostic}`);
  }
  return ligne;
}

/**
 * Ajoute une ligne de produit éphémère au devis actuellement ouvert
 * (section "Produits du devis" visible, voir ouvrirProduitsDuDevis) -
 * formulaire "Ajout d'un produit au devis" confirmé par la vidéo
 * utilisateur : Nom, Quantité, Prix HT, TVA (menu natif, options
 * confirmées par capture d'écran), Description (éditeur riche, même
 * famille que remplirDescriptionEvenement).
 */
async function ajouterProduitDevis(page: import("playwright").Page, ligne: LigneDevis): Promise<void> {
  await fermerDialoguesResiduels(page);
  const boutonNouveauProduit = page.getByText(/nouveau produit éphémère/i).first();
  await boutonNouveauProduit.waitFor({ state: "visible", timeout: 8000 });
  await boutonNouveauProduit.click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByText(/ajout d'un produit au devis/i).first().waitFor({ state: "visible", timeout: 8000 });

  await remplirApresLibelle(page, /^nom$/i, ligne.nom);
  const nomRelu = (await page.getByText(/^nom$/i).first().locator("xpath=following::input[1]").first().inputValue().catch(() => null))?.trim();
  if (nomRelu !== ligne.nom.trim()) {
    throw new SynecDevisError(`Le champ "Nom" du produit contient "${nomRelu}" au lieu de "${ligne.nom}" attendu.`);
  }

  const quantite = ligne.quantite ?? 1;
  if (quantite !== 1) {
    await remplirEtVerifierMontant(page, /^quantité$/i, quantite);
  }

  await remplirEtVerifierMontant(page, /^prix ht$/i, ligne.prixHT);

  const libelleTva = LIBELLES_TVA[ligne.tva ?? "non_defini"];
  const selectTva = page.getByText(/^tva$/i).first().locator("xpath=following::select[1]").first();
  await selectionnerOptionInsensibleCasse(selectTva, libelleTva).catch(() => null);
  // Non bloquant : un échec sur la TVA ne doit pas faire perdre la ligne
  // (nom + prix déjà vérifiés) - Synec garde alors son défaut "Non défini",
  // visible et corrigible à la main dans Synec si besoin.

  if (ligne.description) {
    await remplirDescriptionEvenement(page, ligne.description, /description du produit/i).catch(() => {});
  }

  await cliquerEnregistrerEtFermer(page);
}

/**
 * Ouvre la section "Produits du devis" sur la ligne de devis déjà
 * dépliée (ligneDevis.click() déjà effectué par l'appelant) - icône
 * "Produits" (sans texte visible, identifiée par son attribut title lors
 * de l'exploration explorerDetailDevis).
 */
async function ouvrirProduitsDuDevis(page: import("playwright").Page): Promise<void> {
  const boutonProduits = page.locator('[title="Produits"]').first();
  await boutonProduits.waitFor({ state: "visible", timeout: 8000 });
  await boutonProduits.click();
  await page.getByText(/produits du devis/i).first().waitFor({ state: "visible", timeout: 8000 });
}

/**
 * Lecture best-effort du numéro de devis et des totaux HT/TTC affichés
 * sur sa ligne, pour la confirmation renvoyée à l'appelant (Morgane) -
 * jamais bloquant : le devis est déjà créé avec succès à ce stade, un
 * échec de lecture ne doit jamais faire échouer toute l'opération.
 */
async function lireResumeDevis(page: import("playwright").Page, nomClient: string): Promise<ResultatCreationDevis> {
  try {
    await page.waitForTimeout(500);
    const texte = (await page
      .evaluate(
        `(() => {
          const noeuds = Array.from(document.querySelectorAll('body *'));
          const cible = noeuds.find((el) => el.children.length < 40 && (el.textContent||'').includes(${JSON.stringify(nomClient)}) && (el.textContent||'').includes('DEVIS-'));
          return cible ? cible.textContent.replace(/\\s+/g, ' ').trim().slice(0, 500) : null;
        })()`
      )
      .catch(() => null)) as string | null;
    if (!texte) return { numeroDevis: null, totalHT: null, totalTTC: null };
    return {
      numeroDevis: texte.match(/DEVIS-\d+/)?.[0] ?? null,
      totalHT: texte.match(/HT\s*:\s*([\d\s.,]+€)/)?.[1]?.trim() ?? null,
      totalTTC: texte.match(/TTC\s*:\s*([\d\s.,]+€)/)?.[1]?.trim() ?? null,
    };
  } catch {
    return { numeroDevis: null, totalHT: null, totalTTC: null };
  }
}

/**
 * Crée un devis complet dans Synec (en-tête + lignes de produits),
 * déclenché par Morgane à la demande explicite de l'utilisateur dans la
 * conversation (jamais automatique) - même principe de prudence que
 * envoyerDemandeVersSynec : recherche du client AVANT toute action,
 * vérification des champs financiers critiques (nom/prix de chaque
 * ligne), capture d'écran + journal détaillé en cas d'échec.
 */
export async function creerDevisSynec(prisma: PrismaClient, params: ParametresDevis): Promise<ResultatCreationDevis> {
  if (!params.lignes || params.lignes.length === 0) {
    throw new SynecDevisError("Au moins une ligne (nom + prix HT) est requise pour créer un devis.");
  }

  const { url, identifiant, motDePasse } = obtenirIdentifiants();
  const navigateur = await chromium.launch({ headless: true });
  let page: import("playwright").Page | undefined;
  try {
    page = await navigateur.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await seConnecter(page, identifiant, motDePasse);
    await allerAuxDevis(page);

    await remplirEtEnregistrerEnTeteDevis(page, params);

    const ligneDevis = await trouverLigneDevisParClient(page, params.clientNom);
    await ligneDevis.click();
    await page.waitForTimeout(800);
    await ouvrirProduitsDuDevis(page);

    for (const ligne of params.lignes) {
      await ajouterProduitDevis(page, ligne);
    }

    const resultat = await lireResumeDevis(page, params.clientNom);

    await logEvenement(prisma, {
      evenement: "synec_devis_cree",
      action: `Création d'un devis Synec pour ${params.clientNom}`,
      resultat: `${resultat.numeroDevis ?? "numéro non lu"} — ${params.lignes.length} ligne(s). Total HT : ${resultat.totalHT ?? "?"}, TTC : ${resultat.totalTTC ?? "?"}.`,
    });

    return resultat;
  } catch (err) {
    await page?.screenshot({ path: CHEMIN_CAPTURE_EXPLORATION, fullPage: true }).catch(() => {});
    await logEvenement(prisma, {
      evenement: "synec_devis_erreur",
      action: `Création d'un devis Synec pour ${params.clientNom}`,
      resultat: `Échec : ${(err as Error).message}`,
    }).catch(() => {});
    throw err;
  } finally {
    await navigateur.close();
  }
}

export { CHEMIN_CAPTURE_EXPLORATION };
