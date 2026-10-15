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

const CSV_BASE = [
  "entreprise,type,email,code postal,ville",
  "Syndic Alpha,syndic,alpha@syndic-test.fr,77000,Melun",
  "Assurance Beta,assurance,beta@assurance-test.fr,77300,Fontainebleau",
].join("\n");

test("importerProspectsCsv : import initial, doublon de fichier, doublon de ligne", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { importerProspectsCsv } = await import("../src/services/prospection/sourcing");
  const prisma = new PrismaClient();

  await prisma.envoiCampagne.deleteMany();
  await prisma.prospectStatutChangement.deleteMany();
  await prisma.prospect.deleteMany();
  await prisma.prospectionImport.deleteMany();

  const premier = await importerProspectsCsv(prisma, "prospects.csv", Buffer.from(CSV_BASE, "utf8"));
  assert.equal(premier.statut, "ok");
  assert.equal(premier.nbNouveaux, 2);
  assert.equal(premier.nbDoublons, 0);

  // Meme fichier redepose : doublon au niveau du fichier (hash), aucune nouvelle ligne creee.
  const memeFichier = await importerProspectsCsv(prisma, "prospects.csv", Buffer.from(CSV_BASE, "utf8"));
  assert.equal(memeFichier.statut, "doublon_fichier");
  assert.equal(await prisma.prospect.count(), 2);

  // Fichier different mais contenant une ligne deja connue (meme entreprise + email) : doublon de ligne.
  const csvAvecDoublonDeLigne = [
    "entreprise,type,email,code postal,ville",
    "Syndic Alpha,syndic,alpha@syndic-test.fr,77000,Melun",
    "Syndic Gamma,syndic,gamma@syndic-test.fr,77100,Meaux",
  ].join("\n");
  const second = await importerProspectsCsv(prisma, "prospects2.csv", Buffer.from(csvAvecDoublonDeLigne, "utf8"));
  assert.equal(second.nbNouveaux, 1);
  assert.equal(second.nbDoublons, 1);
  assert.equal(await prisma.prospect.count(), 3);

  await prisma.$disconnect();
});

test("ajouterProspectManuel : cree une fiche avec un historique de statut initial", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { ajouterProspectManuel } = await import("../src/services/prospection/sourcing");
  const prisma = new PrismaClient();

  await prisma.envoiCampagne.deleteMany();
  await prisma.prospectStatutChangement.deleteMany();
  await prisma.prospect.deleteMany();

  const prospect = await ajouterProspectManuel(prisma, { type: "assurance", entreprise: "Cabinet Delta" });
  const historique = await prisma.prospectStatutChangement.findMany({ where: { prospectId: prospect.id } });
  assert.equal(historique.length, 1);
  assert.equal(historique[0].nouveauStatut, "a_contacter");

  await prisma.$disconnect();
});
