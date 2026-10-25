import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/(\?|$)/, "_test$1") : undefined);

if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL (ou DATABASE_URL) manquante : voir .env.example.");
}
process.env.DATABASE_URL = testDatabaseUrl;

before(() => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });
});

const EXPORT_CSV = [
  "Rapport des campagnes",
  "",
  "Campagne,Budget,État,Type de campagne,Clics,Impr.,CTR,CPC moy.,Coût,Conversions",
  '"Serrurier Pas Cher","18,00 €",En veille,Réseau de Recherche,142,6471,"2,19 %","1,23 €","174,60 €",3',
].join("\n");

test("import manuel des campagnes Ads : depot, lecture, dedoublonnage par fichier", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { importerCampagnesAds, dernieresCampagnesImportees } = await import("../src/services/googleAdsImport");
  const prisma = new PrismaClient();

  await t.test("aucun import -> dernieresCampagnesImportees retourne null", async () => {
    assert.equal(await dernieresCampagnesImportees(prisma), null);
  });

  await t.test("depot valide -> campagne retrouvee avec sa source", async () => {
    const resultat = await importerCampagnesAds(prisma, "campagnes.csv", Buffer.from(EXPORT_CSV, "utf8"));
    assert.equal(resultat.nbCampagnes, 1);

    const dernier = await dernieresCampagnesImportees(prisma);
    assert.ok(dernier);
    assert.equal(dernier!.fichierNom, "campagnes.csv");
    assert.equal(dernier!.campagnes.length, 1);
    assert.equal(dernier!.campagnes[0].nom, "Serrurier Pas Cher");
    assert.equal(dernier!.campagnes[0].cout, 174.6);
  });

  await t.test("redeposer le meme fichier -> erreur explicite (deja importe)", async () => {
    await assert.rejects(
      importerCampagnesAds(prisma, "campagnes.csv", Buffer.from(EXPORT_CSV, "utf8")),
      /deja ete importe/
    );
  });

  await t.test("nouvel import -> remplace la photographie precedente (pas d'accumulation)", async () => {
    const autreExport = [
      "Rapport des campagnes",
      "",
      "Campagne,Budget,État,Type de campagne,Clics,Impr.,CTR,CPC moy.,Coût,Conversions",
      '"Dépannage urgence","25,00 €",Actif,Réseau de Recherche,89,3200,"2,78 %","0,95 €","84,55 €",5',
    ].join("\n");
    await importerCampagnesAds(prisma, "campagnes-2.csv", Buffer.from(autreExport, "utf8"));

    const dernier = await dernieresCampagnesImportees(prisma);
    assert.equal(dernier!.fichierNom, "campagnes-2.csv");
    assert.equal(dernier!.campagnes.length, 1);
    assert.equal(dernier!.campagnes[0].nom, "Dépannage urgence");
  });

  await prisma.$disconnect();
});
