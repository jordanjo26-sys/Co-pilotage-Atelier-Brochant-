import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { auditerSiteWeb, analyserPageDestination } from "../src/services/referencementAudit";

/**
 * Teste auditerSiteWeb contre un vrai serveur HTTP local (pas de mock
 * d'appels reseau) : simple, deterministe, et evite toute dependance a un
 * site externe reel dans la suite automatique.
 */
function demarrerServeur(gerer: (chemin: string) => { statut: number; corps: string; contentType?: string }): Promise<{ serveur: Server; origine: string }> {
  return new Promise((resolve) => {
    const serveur = createServer((req, res) => {
      const { statut, corps, contentType } = gerer(req.url ?? "/");
      res.writeHead(statut, { "Content-Type": contentType ?? "text/html" });
      res.end(corps);
    });
    serveur.listen(0, "127.0.0.1", () => {
      const port = (serveur.address() as { port: number }).port;
      resolve({ serveur, origine: `http://127.0.0.1:${port}` });
    });
  });
}

test("auditerSiteWeb : site rendu cote serveur, robots.txt/sitemap.xml/llms.txt reels, aucun robot IA bloque", async () => {
  const HTML_PAGE = `<!doctype html><html><head>
    <title>Serrurier Fichet Île-de-France</title>
    <meta name="description" content="Dépannage de serrures Fichet, intervention rapide.">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="canonical" href="https://exemple.fr/">
    <script type="application/ld+json">{"@type":"LocalBusiness"}</script>
    </head><body>
      <h1>Serrurier Fichet</h1>
      <p>Intervention rapide en Île-de-France, ouverture de porte, remplacement de serrure.</p>
      <p>Nos services : dépannage de serrures Fichet, remplacement de cylindre, réparation de porte blindée, ouverture de porte claquée ou fermée à clé. Nous intervenons rapidement sur toute l'Île-de-France : Paris, Seine-et-Marne, Yvelines, Essonne, Hauts-de-Seine, Seine-Saint-Denis, Val-de-Marne, Val-d'Oise. Appelez-nous au 09 72 57 44 50.</p>
    </body></html>`;
  const ROBOTS_TXT = "User-agent: *\nAllow: /\nUser-agent: GPTBot\nDisallow: /\n";
  const SITEMAP_XML = `<?xml version="1.0"?><urlset></urlset>`;

  const { serveur, origine } = await demarrerServeur((chemin) => {
    if (chemin === "/robots.txt") return { statut: 200, corps: ROBOTS_TXT, contentType: "text/plain" };
    if (chemin === "/sitemap.xml") return { statut: 200, corps: SITEMAP_XML, contentType: "application/xml" };
    if (chemin === "/llms.txt") return { statut: 404, corps: "Not found" };
    return { statut: 200, corps: HTML_PAGE };
  });

  try {
    const audit = await auditerSiteWeb(`${origine}/`);
    assert.equal(audit.codeStatut, 200);
    assert.equal(audit.titre, "Serrurier Fichet Île-de-France");
    assert.equal(audit.metaDescription, "Dépannage de serrures Fichet, intervention rapide.");
    assert.equal(audit.viewportMobile, true);
    assert.equal(audit.canonical, "https://exemple.fr/");
    assert.equal(audit.nombreBlocsJsonLd, 1);
    assert.ok(audit.longueurTexteVisibleSansJavascript > 50, "le texte visible doit inclure le contenu du <body>");
    assert.equal(audit.renduCoteClientUniquement, false);
    assert.equal(audit.robotsTxt.existe, true);
    assert.equal(audit.sitemapXml.existe, true);
    assert.equal(audit.llmsTxt.existe, false);
    assert.deepEqual(audit.robotsIaBloques, ["GPTBot"]);
  } finally {
    serveur.close();
  }
});

test("auditerSiteWeb : application monopage (SPA) - detecte le rendu cote client uniquement et l'absence de vrais fichiers racine", async () => {
  const HTML_SHELL = `<!doctype html><html><head><title>Mon Appli</title></head><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>`;

  const { serveur, origine } = await demarrerServeur(() => ({ statut: 200, corps: HTML_SHELL }));

  try {
    const audit = await auditerSiteWeb(`${origine}/`);
    assert.equal(audit.renduCoteClientUniquement, true);
    assert.ok(audit.longueurTexteVisibleSansJavascript < 200);
    // robots.txt/sitemap.xml/llms.txt renvoient tous la coquille HTML (fallback SPA) : aucun n'est un vrai fichier.
    assert.equal(audit.robotsTxt.existe, false);
    assert.equal(audit.sitemapXml.existe, false);
    assert.equal(audit.llmsTxt.existe, false);
    assert.deepEqual(audit.robotsIaBloques, []);
  } finally {
    serveur.close();
  }
});

test("analyserPageDestination : page avec telephone cliquable, formulaire et appels a l'action", async () => {
  const HTML_PAGE = `<!doctype html><html><head>
    <title>Serrurier Fichet</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    </head><body>
      <h1>Serrurier Fichet</h1>
      <p>Porte bloquee ou serrure cassee ? Appelez-nous au <a href="tel:0972574450">09 72 57 44 50</a> pour une intervention rapide en Île-de-France, 7 jours sur 7 et 24 heures sur 24, sur tout type de serrure.</p>
      <form><input name="nom"><button>Demander un devis</button></form>
    </body></html>`;

  const { serveur, origine } = await demarrerServeur(() => ({ statut: 200, corps: HTML_PAGE }));

  try {
    const analyse = await analyserPageDestination(`${origine}/`);
    assert.equal(analyse.codeStatut, 200);
    assert.equal(analyse.viewportMobile, true);
    assert.deepEqual(analyse.telephonesCliquables, ["0972574450"]);
    assert.equal(analyse.formulaireDetecte, true);
    assert.ok(analyse.motsAppelActionTrouves.includes("appelez"));
    assert.ok(analyse.motsAppelActionTrouves.includes("devis"));
    assert.equal(analyse.renduCoteClientUniquement, false);
  } finally {
    serveur.close();
  }
});

test("analyserPageDestination : page sans telephone ni formulaire ni appel a l'action", async () => {
  const HTML_PAGE = `<!doctype html><html><head><title>Page</title></head><body><p>Contenu sans rapport, juste du texte neutre et suffisamment long pour ne pas etre considere comme un rendu cote client uniquement par l'heuristique de longueur.</p></body></html>`;

  const { serveur, origine } = await demarrerServeur(() => ({ statut: 200, corps: HTML_PAGE }));

  try {
    const analyse = await analyserPageDestination(`${origine}/`);
    assert.deepEqual(analyse.telephonesCliquables, []);
    assert.equal(analyse.formulaireDetecte, false);
    assert.deepEqual(analyse.motsAppelActionTrouves, []);
  } finally {
    serveur.close();
  }
});
