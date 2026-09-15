import { test } from "node:test";
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

// Seule la branche "aucune boite Gmail active" est testable sans mocker
// l'API Gmail elle-meme (jamais fait dans ce projet, voir tests/gmailSync.test.ts) :
// couvre la regression reelle constatee en production, ou l'absence
// d'envoi du recapitulatif restait totalement silencieuse (aucune trace en
// base), rendant une panne prolongee indiagnosticable depuis l'application.
test("recapitulatif quotidien : absence de boite Gmail active journalisee explicitement", async (t) => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const { envoyerRecapQuotidien } = await import("../src/services/dailyRecap");
  const prisma = new PrismaClient();

  await t.test("aucune connexion Gmail active -> journalise un evenement explicite, ne leve pas d'erreur", async () => {
    await assert.doesNotReject(envoyerRecapQuotidien(prisma, new Date()));

    const evenements = await prisma.journalEvenement.findMany({ where: { evenement: "recap_quotidien_non_envoye" } });
    assert.equal(evenements.length, 1);
  });

  await prisma.$disconnect();
});
