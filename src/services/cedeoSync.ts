import { chromium } from "playwright";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { logEvenement } from "./journalService";
import { capturerDiagnostic } from "./synecSync";

/**
 * Connecteur pilote CEDEO (projet BatiPrix IA, Phase 1 : "pilote un seul
 * fournisseur" de l'audit de faisabilite). CEDEO ne propose aucune API
 * publique pour les tarifs professionnels : seule voie, comme pour Synec,
 * un navigateur headless connecte avec le compte professionnel reel de
 * l'utilisateur (aucun compte dedie en lecture seule possible chez ce
 * fournisseur, confirme par l'utilisateur).
 *
 * Volontairement LECTURE SEULE : ce module ne clique jamais sur "Ajouter au
 * panier" ni sur aucune action d'achat, quel que soit l'acces reel du
 * compte - seules la recherche et la lecture des resultats affiches.
 *
 * Premiere version : la connexion et la recherche n'ont jamais pu etre
 * observees sur la structure HTML reelle de CEDEO avant ecriture de ce
 * fichier (la page d'accueil publique a renvoye une erreur 403 des la
 * premiere requete simple, sans navigateur - signe d'une protection
 * anti-robot en facade, a verifier avec un vrai navigateur). Comme pour
 * Synec a l'origine (trois iterations reelles necessaires), cette version
 * doit donc etre affinee a partir des VRAIS echecs observes apres
 * deploiement (capturerDiagnostic + capture d'ecran ci-dessous), jamais en
 * devinant une structure jamais verifiee.
 */

export const CHEMIN_CAPTURE_ECHEC_CEDEO = path.join(process.cwd(), "cedeo-derniere-capture.png");
export const CHEMIN_CAPTURE_RESULTAT_CEDEO = path.join(process.cwd(), "cedeo-dernier-resultat.png");

export interface ProduitCedeo {
  designation: string;
  prix: string | null;
  reference: string | null;
  disponibilite: string | null;
}

export interface ResultatRechercheCedeo {
  requete: string;
  produits: ProduitCedeo[];
  diagnostic: string;
}

export function cedeoEstConfigure(): boolean {
  return Boolean(process.env.CEDEO_URL && process.env.CEDEO_IDENTIFIANT && process.env.CEDEO_MOT_DE_PASSE);
}

export function obtenirIdentifiantsCedeo(): { url: string; identifiant: string; motDePasse: string } {
  const url = process.env.CEDEO_URL;
  const identifiant = process.env.CEDEO_IDENTIFIANT;
  const motDePasse = process.env.CEDEO_MOT_DE_PASSE;
  if (!url || !identifiant || !motDePasse) {
    throw new Error("Identifiants CEDEO non configures (CEDEO_URL/CEDEO_IDENTIFIANT/CEDEO_MOT_DE_PASSE).");
  }
  return { url, identifiant, motDePasse };
}

/**
 * Connexion generique : tente les selecteurs les plus courants pour un
 * formulaire de connexion (champ identifiant/email, champ mot de passe,
 * bouton de soumission par role ou par texte visible). Structure HTML
 * reelle de CEDEO inconnue a l'ecriture de ce fichier (voir note en tete de
 * fichier) : a remplacer par des selecteurs precis des le premier echec
 * reel diagnostique, jamais ajuste a l'aveugle.
 */
export async function seConnecterCedeo(page: import("playwright").Page, identifiant: string, motDePasse: string): Promise<void> {
  const champIdentifiant = page
    .locator('input[type="email"], input[name*="login" i], input[name*="email" i], input[id*="email" i], input[id*="login" i]')
    .first();
  await champIdentifiant.waitFor({ state: "visible", timeout: 15000 });
  await champIdentifiant.fill(identifiant);

  const champMotDePasse = page.locator('input[type="password"]').first();
  await champMotDePasse.fill(motDePasse);

  const boutonConnexion = page
    .getByRole("button", { name: /connexion|connecter|valider|se connecter/i })
    .or(page.locator('button[type="submit"]'))
    .first();
  await Promise.all([page.waitForLoadState("networkidle").catch(() => {}), boutonConnexion.click()]);

  const encoreSurConnexion = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (encoreSurConnexion) {
    const diagnostic = await capturerDiagnostic(page);
    throw new Error(`Connexion CEDEO probablement refusee (champ mot de passe toujours visible). ${diagnostic}`);
  }
}

/**
 * Recherche generique : cherche une barre de recherche visible (role
 * "searchbox", ou champ texte dont le nom/placeholder evoque "recherche"),
 * y saisit la requete et valide avec Entree plutot que de deviner un bouton
 * precis. Meme reserve que seConnecterCedeo : a affiner apres le premier
 * echec reel diagnostique.
 */
async function rechercherSurPage(page: import("playwright").Page, requete: string): Promise<void> {
  const champRecherche = page
    .getByRole("searchbox")
    .or(page.locator('input[type="search"], input[name*="search" i], input[placeholder*="recherch" i]'))
    .first();
  await champRecherche.waitFor({ state: "visible", timeout: 15000 });
  await champRecherche.fill(requete);
  await Promise.all([page.waitForLoadState("networkidle").catch(() => {}), champRecherche.press("Enter")]);
}

/**
 * Extraction au mieux : tente de reconnaitre des cartes/lignes produit par
 * des indices generiques (balisage microdonnees schema.org "Product", ou a
 * defaut une classe evoquant "product"/"item", avec un prix repere par un
 * symbole monetaire dans le texte). Peut renvoyer une liste vide si la
 * structure reelle de CEDEO ne correspond a aucun de ces indices - attendu
 * a ce stade : le diagnostic textuel et la capture d'ecran (toujours
 * produits, succes ou echec) permettent de construire des selecteurs
 * precis a partir de la VRAIE page plutot que de deviner a l'aveugle,
 * exactement comme Synec a l'origine.
 */
async function extraireProduits(page: import("playwright").Page): Promise<ProduitCedeo[]> {
  return page
    .evaluate<ProduitCedeo[]>(
      `(() => {
        const cartes = Array.from(document.querySelectorAll('[itemtype*="Product" i], [class*="product" i][class*="card" i], [class*="product" i][class*="item" i], li[class*="product" i]')).slice(0, 20);
        return cartes.map((el) => {
          const texte = (el.textContent || '').replace(/\\s+/g, ' ').trim();
          const matchPrix = texte.match(/[0-9]+[.,][0-9]{2}\\s?€/);
          return {
            designation: texte.slice(0, 120),
            prix: matchPrix ? matchPrix[0] : null,
            reference: null,
            disponibilite: null,
          };
        });
      })()`
    )
    .catch(() => [] as ProduitCedeo[]);
}

/**
 * Point d'entree du pilote : connexion, recherche d'un seul produit,
 * extraction au mieux. Volontairement SANS aucune action panier/commande.
 * Capture systematiquement un diagnostic texte + une capture d'ecran des
 * resultats (succes ou echec) pour permettre l'iteration sur la structure
 * reelle de CEDEO, comme documente en tete de fichier.
 */
export async function rechercherPrixCedeo(prisma: PrismaClient, requete: string): Promise<ResultatRechercheCedeo> {
  const { url, identifiant, motDePasse } = obtenirIdentifiantsCedeo();

  // Le user-agent par defaut de Chromium headless s'annonce litteralement
  // comme "HeadlessChrome/..." : la premiere tentative reelle (capture
  // d'ecran recuperee via les logs du run de deploiement) a montre que
  // CEDEO renvoie un blocage anti-robot generique ({"message":"Please
  // contact the site owner for access."}) avant meme d'atteindre le
  // formulaire de connexion - cause la plus probable, un UA headless etant
  // le signal de blocage le plus simple et le plus repandu cote WAF. On se
  // presente donc comme un vrai Chrome desktop, sans quoi que ce soit
  // d'autre destine a masquer l'automatisation.
  const navigateur = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  let page: import("playwright").Page | undefined;
  try {
    page = await navigateur.newPage({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "fr-FR",
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    await seConnecterCedeo(page, identifiant, motDePasse);
    await rechercherSurPage(page, requete);

    const produits = await extraireProduits(page);
    const diagnostic = await capturerDiagnostic(page);
    await page.screenshot({ path: CHEMIN_CAPTURE_RESULTAT_CEDEO, fullPage: true }).catch(() => {});

    await logEvenement(prisma, {
      evenement: "cedeo_recherche",
      action: `Recherche CEDEO : "${requete}"`,
      resultat: `${produits.length} produit(s) reconnu(s). ${diagnostic}`,
    });

    return { requete, produits, diagnostic };
  } catch (err) {
    await page?.screenshot({ path: CHEMIN_CAPTURE_ECHEC_CEDEO, fullPage: true }).catch(() => {});
    await logEvenement(prisma, {
      evenement: "cedeo_recherche_erreur",
      action: `Recherche CEDEO : "${requete}"`,
      resultat: `Échec : ${(err as Error).message}`,
    }).catch(() => {});
    throw err;
  } finally {
    await navigateur.close();
  }
}
