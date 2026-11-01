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

export { CHEMIN_CAPTURE_EXPLORATION };
