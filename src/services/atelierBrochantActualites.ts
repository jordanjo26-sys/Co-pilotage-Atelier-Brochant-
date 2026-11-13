import { chromium, type Page } from "playwright";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { logEvenement } from "./journalService";

/**
 * Publication automatisee des "actualites" du site atelier-brochant.com
 * (tableau de bord admin construit sur emergent.sh - demande explicite de
 * l'utilisateur : "j'ai besoin que tu crees une IA pour que apres avoir
 * valide elle publie a la place"). Comme Synec (voir synecSync.ts), ce
 * tableau de bord ne propose aucune API : seule voie d'automatisation, un
 * navigateur headless qui se connecte avec les identifiants admin et
 * pilote le meme formulaire qu'un utilisateur humain.
 *
 * A la difference de PagesJaunes (pagesJaunesActions.ts, SSO Cloudflare
 * bloquant explicitement les navigateurs automatises - simple proposition
 * a copier-coller donc), ce tableau de bord a ete verifie directement par
 * un navigateur headless (connexion, creation puis suppression d'un
 * brouillon de test, toutes reussies) : l'automatisation complete est donc
 * possible ici, creation du brouillon ET clic "Valider et publier" compris.
 *
 * Discipline inchangee malgre cette capacite : cette fonction ne doit
 * JAMAIS etre appelee par Morgane sans que l'utilisateur ait explicitement
 * valide le texte exact dans la conversation au prealable (meme principe
 * que creerDevisSynec) - "rien n'est publie sans votre validation" est
 * aussi le principe affiche par le tableau de bord lui-meme.
 */

export class AtelierBrochantActualiteError extends Error {}

const URL_BASE = "https://atelier-brochant.com";

// Capture d'ecran du dernier echec, servie par GET
// /api/atelier-brochant/capture-echec - meme principe que
// CHEMIN_CAPTURE_ECHEC dans synecSync.ts : un diagnostic textuel seul ne
// suffit pas a comprendre un echec sur une interface jamais vue avant.
export const CHEMIN_CAPTURE_ECHEC = path.join(process.cwd(), "atelier-brochant-actualite-derniere-capture.png");

// Options exactes du formulaire "Nouvel article", relevees par inspection
// directe (connexion reelle au tableau de bord, formulaire /admin/actualites/nouveau).
export const VILLES_ACTUALITES = [
  "Lagny-sur-Marne",
  "Melun",
  "Meaux",
  "Chelles",
  "Torcy",
  "Bussy-Saint-Georges",
  "Serris",
  "Chessy",
  "Montévrain",
  "Saint-Thibault-des-Vignes",
  "Thorigny-sur-Marne",
  "Pomponne",
  "Champs-sur-Marne",
  "Noisiel",
  "Dammarie-les-Lys",
  "Le Mée-sur-Seine",
  "Savigny-le-Temple",
  "Seine-et-Marne",
] as const;

export const METIERS_ACTUALITES = ["Plomberie", "Chauffage", "Électricité", "Serrurerie", "Énergies renouvelables"] as const;

export interface NouvelleActualite {
  /** Max 70 caracteres (limite affichee par le formulaire). */
  titre: string;
  /** Resume affiche dans la liste des actualites, max 200 caracteres. */
  resume: string;
  /** Ligne vide entre paragraphes, "## " pour un intertitre. */
  texte: string;
  ville: (typeof VILLES_ACTUALITES)[number];
  metier: (typeof METIERS_ACTUALITES)[number];
  /** Balise <title> SEO, max 60 caracteres. */
  titreGoogle: string;
  /** Meta description SEO, max 155 caracteres. */
  texteGoogle: string;
}

export interface ResultatActualite {
  id: string;
  url: string;
  publiee: boolean;
}

export function atelierBrochantAdminEstConfigure(): boolean {
  return Boolean(process.env.ATELIER_BROCHANT_ADMIN_EMAIL && process.env.ATELIER_BROCHANT_ADMIN_MOT_DE_PASSE);
}

function obtenirIdentifiantsAdmin(): { email: string; motDePasse: string } {
  const email = process.env.ATELIER_BROCHANT_ADMIN_EMAIL;
  const motDePasse = process.env.ATELIER_BROCHANT_ADMIN_MOT_DE_PASSE;
  if (!email || !motDePasse) {
    throw new AtelierBrochantActualiteError(
      "Identifiants admin atelier-brochant.com non configures (ATELIER_BROCHANT_ADMIN_EMAIL / ATELIER_BROCHANT_ADMIN_MOT_DE_PASSE, voir .env.example)."
    );
  }
  return { email, motDePasse };
}

/**
 * Connexion au tableau de bord (/admin/connexion) - formulaire simple
 * email/mot de passe, verifie directement. Au bout de 5 mots de passe
 * errones, le tableau de bord bloque la connexion pendant 15 minutes
 * (annonce par son propre agent emergent.sh) : echouer explicitement des
 * le premier refus plutot que de reessayer est donc important ici.
 */
async function seConnecterAdmin(page: Page): Promise<void> {
  const { email, motDePasse } = obtenirIdentifiantsAdmin();
  await page.goto(`${URL_BASE}/admin/connexion`, { waitUntil: "networkidle", timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(motDePasse);
  await page
    .locator('button[type="submit"], button:has-text("Connexion"), button:has-text("Se connecter")')
    .first()
    .click();

  const debut = Date.now();
  while (Date.now() - debut < 15000) {
    await page.waitForTimeout(500);
    if (!page.url().includes("/connexion")) return;
  }
  throw new AtelierBrochantActualiteError(
    "Connexion au tableau de bord atelier-brochant.com refusee (identifiants incorrects, ou page de connexion modifiee depuis). " +
      "Ne pas reessayer automatiquement : 5 echecs bloquent la connexion pendant 15 minutes."
  );
}

/**
 * Remplit le formulaire "Nouvel article" (ouvert depuis le bouton
 * "Rediger" du tableau de bord, route /admin/actualites/nouveau). Champs
 * cibles par leur libelle associe (getByLabel), confirme par inspection
 * directe du formulaire reel - les regex ancrees en debut de libelle
 * distinguent "Titre" de "Titre Google" et "Texte" de "Texte Google"
 * (meme prefixe sinon, le reste du libelle etant un compteur de
 * caracteres qui varie).
 */
async function remplirFormulaireActualite(page: Page, actualite: NouvelleActualite): Promise<void> {
  await page.getByLabel(/^Titre\n/).fill(actualite.titre);
  await page.getByLabel(/^Résumé/).fill(actualite.resume);
  await page.getByLabel(/^Texte\n/).fill(actualite.texte);
  await page.getByLabel(/^Ville\n/).selectOption({ label: actualite.ville });
  await page.getByLabel(/^Métier\n/).selectOption({ label: actualite.metier });
  await page.getByLabel(/^Titre Google\n/).fill(actualite.titreGoogle);
  await page.getByLabel(/^Texte Google\n/).fill(actualite.texteGoogle);
}

/**
 * Cree (et, sauf demande contraire, publie) une actualite. Deux etapes
 * distinctes cote tableau de bord, jamais court-circuitees : "Enregistrer"
 * cree le brouillon (invisible publiquement) et redirige vers
 * /admin/actualites/{id} (ecran "Relire et valider") ; seul un second clic
 * explicite sur "Valider et publier" le rend visible sur le site.
 *
 * N'attache aucune image : l'utilisateur choisit lui-meme ses photos de
 * chantier reelles dans le tableau de bord apres coup (jamais d'image
 * generee par IA choisie a sa place - meme discipline "jamais deviner" que
 * pour le texte).
 */
export async function publierActualite(
  prisma: PrismaClient,
  actualite: NouvelleActualite,
  options: { publierImmediatement?: boolean } = {}
): Promise<ResultatActualite> {
  const publierImmediatement = options.publierImmediatement ?? true;
  const navigateur = await chromium.launch({ headless: true });
  let page: Page | undefined;
  try {
    page = await navigateur.newPage();
    await seConnecterAdmin(page);
    await page.goto(`${URL_BASE}/admin/actualites/nouveau`, { waitUntil: "networkidle", timeout: 20000 });

    await remplirFormulaireActualite(page, actualite);
    await page.locator('button:has-text("Enregistrer")').first().click();

    const debutAttente = Date.now();
    while (Date.now() - debutAttente < 15000 && page.url().endsWith("/nouveau")) {
      await page.waitForTimeout(500);
    }
    const correspondance = page.url().match(/\/admin\/actualites\/([a-f0-9-]+)$/);
    if (!correspondance) {
      throw new AtelierBrochantActualiteError(
        `Brouillon non enregistre (URL inattendue apres clic "Enregistrer" : ${page.url()}).`
      );
    }
    const id = correspondance[1];

    let publiee = false;
    if (publierImmediatement) {
      await page.locator('button:has-text("Valider et publier")').first().click();
      await page.waitForTimeout(2000);
      publiee = true;
    }

    await logEvenement(prisma, {
      evenement: "atelier_brochant_actualite_creee",
      action: `Actualite atelier-brochant.com : "${actualite.titre}" (${actualite.ville} / ${actualite.metier})`,
      resultat: publiee ? `Publiee (id ${id}).` : `Brouillon enregistre (id ${id}), non publie.`,
    });

    return { id, url: `${URL_BASE}/admin/actualites/${id}`, publiee };
  } catch (err) {
    await page?.screenshot({ path: CHEMIN_CAPTURE_ECHEC, fullPage: true }).catch(() => {});
    await logEvenement(prisma, {
      evenement: "atelier_brochant_actualite_erreur",
      action: `Creation actualite atelier-brochant.com : "${actualite.titre}"`,
      resultat: `Echec : ${(err as Error).message}`,
    }).catch(() => {});
    throw err;
  } finally {
    await navigateur.close();
  }
}
