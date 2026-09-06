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

test("controle du releve fournisseur : presence de factures connues", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { controlerReleveFournisseur } = await import("../src/services/controleReleves");
  const prisma = new PrismaClient();

  await t.test("aucune facture connue -> anomalie creee", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "Cedeo" } });
    await controlerReleveFournisseur(prisma, { fournisseurId: f.id, fournisseurNom: "Cedeo", fichierNom: "releve.pdf" });

    const anomalies = await prisma.anomalie.findMany({ where: { type: "releve_sans_facture_connue" } });
    assert.equal(anomalies.length, 1);
    const preuves = JSON.parse(anomalies[0].preuves || "{}");
    assert.equal(preuves.fournisseurId, f.id);
  });

  await t.test("appel repete pour le meme fournisseur -> pas de doublon", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "Point P" } });
    await controlerReleveFournisseur(prisma, { fournisseurId: f.id, fournisseurNom: "Point P", fichierNom: "releve1.pdf" });
    await controlerReleveFournisseur(prisma, { fournisseurId: f.id, fournisseurNom: "Point P", fichierNom: "releve2.pdf" });

    const anomalies = await prisma.anomalie.findMany({ where: { type: "releve_sans_facture_connue" } });
    const pourCeFournisseur = anomalies.filter((a) => JSON.parse(a.preuves || "{}").fournisseurId === f.id);
    assert.equal(pourCeFournisseur.length, 1);
  });

  await t.test("au moins une facture connue -> aucune anomalie", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "CEP" } });
    await prisma.documentFournisseur.create({ data: { type: "facture", fournisseurId: f.id, fichierNom: "facture.pdf" } });

    await controlerReleveFournisseur(prisma, { fournisseurId: f.id, fournisseurNom: "CEP", fichierNom: "releve.pdf" });

    const anomalies = await prisma.anomalie.findMany({ where: { type: "releve_sans_facture_connue" } });
    const pourCeFournisseur = anomalies.filter((a) => JSON.parse(a.preuves || "{}").fournisseurId === f.id);
    assert.equal(pourCeFournisseur.length, 0);
  });

  await t.test("fournisseurId absent -> ne fait rien (pas d'erreur)", async () => {
    await assert.doesNotReject(controlerReleveFournisseur(prisma, { fournisseurId: null, fournisseurNom: "Inconnu", fichierNom: "releve.pdf" }));
  });

  await prisma.$disconnect();
});
