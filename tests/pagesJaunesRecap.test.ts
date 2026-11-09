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

// Meme principe que tests/googleAdsRecap.test.ts : seules les branches "non
// envoyee" sont testables sans mocker l'API Gmail/Anthropic elle-meme -
// couvre la regression a eviter (un echec silencieux de ce planificateur,
// sans aucune trace en base, le rendrait indiagnosticable).
test("analyse hebdomadaire PagesJaunes : branches 'non envoyee' journalisees explicitement", async (t) => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const { envoyerAnalysePagesJaunes } = await import("../src/services/pagesJaunesRecap");
  const { creerPropositionActualite, accepterPropositionPagesJaunes, marquerPublieePropositionPagesJaunes } = await import("../src/services/pagesJaunesActions");
  const prisma = new PrismaClient();

  await t.test("objectif mensuel deja atteint -> ignoree, aucun appel Gmail/Anthropic necessaire", async () => {
    await prisma.propositionPagesJaunes.deleteMany({});
    await prisma.journalEvenement.deleteMany({ where: { evenement: { in: ["analyse_pagesjaunes_non_envoyee", "analyse_pagesjaunes_envoyee", "analyse_pagesjaunes_erreur"] } } });

    for (let i = 0; i < 4; i++) {
      const proposition = await creerPropositionActualite(prisma, { texte: `Actualite ${i}`, justification: "test" });
      await accepterPropositionPagesJaunes(prisma, proposition.id);
      await marquerPublieePropositionPagesJaunes(prisma, proposition.id);
    }

    await assert.doesNotReject(envoyerAnalysePagesJaunes(prisma, new Date()));
    const evenements = await prisma.journalEvenement.findMany({ where: { evenement: "analyse_pagesjaunes_non_envoyee" } });
    assert.equal(evenements.length, 1);
    assert.match(evenements[0].resultat ?? "", /objectif du mois deja atteint/);
  });

  await t.test("objectif pas atteint mais aucune connexion Gmail active -> journalise un evenement explicite", async () => {
    await prisma.propositionPagesJaunes.deleteMany({});
    await prisma.journalEvenement.deleteMany({ where: { evenement: { in: ["analyse_pagesjaunes_non_envoyee", "analyse_pagesjaunes_envoyee", "analyse_pagesjaunes_erreur"] } } });

    await assert.doesNotReject(envoyerAnalysePagesJaunes(prisma, new Date()));
    const evenements = await prisma.journalEvenement.findMany({ where: { evenement: "analyse_pagesjaunes_non_envoyee" } });
    assert.equal(evenements.length, 1);
    assert.match(evenements[0].resultat ?? "", /aucune boite Gmail active/);
  });

  await prisma.$disconnect();
});
