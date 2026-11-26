// Script autonome - pilote BatiPrix IA, test CEDEO depuis un poste local
// (PC/Mac sur une connexion internet normale, PAS le serveur OVH).
//
// CEDEO bloque les recherches automatisees depuis l'IP du serveur OVH
// (protection anti-robot Imperva/Incapsula, confirmee par deux tests reels
// - voir le commentaire en tete de src/services/cedeoSync.ts dans le
// depot principal). Ce script reprend exactement la meme logique de
// connexion/recherche/extraction, mais concu pour tourner sur un poste
// Windows/Mac ordinaire plutot que sur le serveur, sans aucune dependance
// a la base de donnees de production.
//
// Usage (une fois Node.js et les dependances installes, voir LISEZ-MOI.txt) :
//   node cedeo-recherche-locale.js "tube multicouche 16"

require("dotenv").config();
const { chromium } = require("playwright");
const path = require("path");

const CHEMIN_CAPTURE_ECHEC = path.join(process.cwd(), "cedeo-derniere-capture.png");
const CHEMIN_CAPTURE_RESULTAT = path.join(process.cwd(), "cedeo-dernier-resultat.png");

function obtenirIdentifiants() {
  const url = process.env.CEDEO_URL;
  const identifiant = process.env.CEDEO_IDENTIFIANT;
  const motDePasse = process.env.CEDEO_MOT_DE_PASSE;
  if (!url || !identifiant || !motDePasse) {
    throw new Error(
      "CEDEO_URL / CEDEO_IDENTIFIANT / CEDEO_MOT_DE_PASSE ne sont pas tous les trois configures dans .env (voir LISEZ-MOI.txt)."
    );
  }
  return { url, identifiant, motDePasse };
}

async function capturerDiagnostic(page) {
  const url = page.url();
  const titre = await page.title().catch(() => "?");
  const texte = await page
    .locator("body")
    .innerText()
    .then((t) => t.replace(/\s+/g, " ").trim().slice(0, 400))
    .catch(() => "(texte illisible)");
  return `URL actuelle : ${url} — titre : "${titre}" — texte visible : "${texte}"`;
}

async function seConnecter(page, identifiant, motDePasse) {
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

async function rechercher(page, requete) {
  const champRecherche = page
    .getByRole("searchbox")
    .or(page.locator('input[type="search"], input[name*="search" i], input[placeholder*="recherch" i]'))
    .first();
  await champRecherche.waitFor({ state: "visible", timeout: 15000 });
  await champRecherche.fill(requete);
  await Promise.all([page.waitForLoadState("networkidle").catch(() => {}), champRecherche.press("Enter")]);
}

async function extraireProduits(page) {
  return page
    .evaluate(() => {
      const cartes = Array.from(
        document.querySelectorAll(
          '[itemtype*="Product" i], [class*="product" i][class*="card" i], [class*="product" i][class*="item" i], li[class*="product" i]'
        )
      ).slice(0, 20);
      return cartes.map((el) => {
        const texte = (el.textContent || "").replace(/\s+/g, " ").trim();
        const matchPrix = texte.match(/[0-9]+[.,][0-9]{2}\s?€/);
        return {
          designation: texte.slice(0, 120),
          prix: matchPrix ? matchPrix[0] : null,
        };
      });
    })
    .catch(() => []);
}

async function main() {
  const requete = process.argv[2];
  if (!requete) {
    console.error('Usage : node cedeo-recherche-locale.js "produit a chercher"');
    process.exit(1);
  }

  const { url, identifiant, motDePasse } = obtenirIdentifiants();

  console.log(`Recherche CEDEO en cours pour : "${requete}"...`);
  const navigateur = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  let page;
  try {
    page = await navigateur.newPage({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "fr-FR",
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    await seConnecter(page, identifiant, motDePasse);
    await rechercher(page, requete);

    const produits = await extraireProduits(page);
    const diagnostic = await capturerDiagnostic(page);
    await page.screenshot({ path: CHEMIN_CAPTURE_RESULTAT, fullPage: true }).catch(() => {});

    console.log("");
    console.log(`Succes. ${produits.length} produit(s) reconnu(s).`);
    console.log(diagnostic);
    console.log("");
    console.log(JSON.stringify(produits, null, 2));
    console.log("");
    console.log(`Capture d'ecran du resultat : ${CHEMIN_CAPTURE_RESULTAT}`);
  } catch (err) {
    await page?.screenshot({ path: CHEMIN_CAPTURE_ECHEC, fullPage: true }).catch(() => {});
    console.log("");
    console.log(`Échec : ${err.message}`);
    console.log(`Capture d'écran de l'échec : ${CHEMIN_CAPTURE_ECHEC}`);
    process.exitCode = 1;
  } finally {
    await navigateur.close();
  }
}

main();
