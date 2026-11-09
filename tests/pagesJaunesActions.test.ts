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

// Module PagesJaunes/Solocal Manager, mode "assiste" (pas d'API, SSO bloque
// les navigateurs automatises - voir pagesJaunesActions.ts) : aucune
// publication reelle n'est jamais declenchee par ce module, seulement le
// pipeline propose/accepte/refuse/marque-publiee.
test("Module PagesJaunes", async (t) => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const {
    creerPropositionActualitePagesJaunes,
    listerPropositionsActualitesPagesJaunes,
    accepterPropositionActualitePagesJaunes,
    refuserPropositionActualitePagesJaunes,
    marquerPublieePropositionActualitePagesJaunes,
  } = await import("../src/services/pagesJaunesActions");
  const prisma = new PrismaClient();

  await t.test("creerPropositionActualitePagesJaunes : rejette un etablissement manquant", async () => {
    await assert.rejects(
      creerPropositionActualitePagesJaunes(prisma, { etablissement: "", texte: "Texte", justification: "test" }),
      /etablissement manquant/
    );
  });

  await t.test("creerPropositionActualitePagesJaunes : rejette un texte manquant", async () => {
    await assert.rejects(
      creerPropositionActualitePagesJaunes(prisma, { etablissement: "A.B Atelier Brochant", texte: "", justification: "test" }),
      /texte manquant/
    );
  });

  await t.test("creerPropositionActualitePagesJaunes : cree bien une proposition en_attente, listee ensuite", async () => {
    await prisma.propositionActualitePagesJaunes.deleteMany({});
    const proposition = await creerPropositionActualitePagesJaunes(prisma, {
      etablissement: "A.B Atelier Brochant - Lagny-sur-Marne",
      texte: "Nouvelle intervention reussie ce matin !",
      justification: "Actualite du jour",
    });
    assert.equal(proposition.statut, "en_attente");

    const liste = await listerPropositionsActualitesPagesJaunes(prisma);
    assert.equal(liste.length, 1);
    assert.equal(liste[0].id, proposition.id);
  });

  await t.test("marquerPublieePropositionActualitePagesJaunes : refuse une proposition qui n'est pas acceptee", async () => {
    await prisma.propositionActualitePagesJaunes.deleteMany({});
    const proposition = await creerPropositionActualitePagesJaunes(prisma, {
      etablissement: "A.B Atelier Brochant",
      texte: "Texte",
      justification: "test",
    });
    await assert.rejects(marquerPublieePropositionActualitePagesJaunes(prisma, proposition.id), /pas "acceptee"/);
  });

  await t.test("accepterPropositionActualitePagesJaunes puis marquerPublieePropositionActualitePagesJaunes : flux complet sans aucune publication automatique", async () => {
    await prisma.propositionActualitePagesJaunes.deleteMany({});
    const proposition = await creerPropositionActualitePagesJaunes(prisma, {
      etablissement: "A.B Atelier Brochant",
      texte: "Texte",
      justification: "test",
    });

    const acceptee = await accepterPropositionActualitePagesJaunes(prisma, proposition.id);
    assert.equal(acceptee.statut, "acceptee");
    assert.ok(acceptee.decideLe);

    const publiee = await marquerPublieePropositionActualitePagesJaunes(prisma, proposition.id);
    assert.equal(publiee.statut, "publiee");
    assert.ok(publiee.publieeLe);
  });

  await t.test("refuserPropositionActualitePagesJaunes : passe a refusee", async () => {
    await prisma.propositionActualitePagesJaunes.deleteMany({});
    const proposition = await creerPropositionActualitePagesJaunes(prisma, {
      etablissement: "A.B Atelier Brochant",
      texte: "Texte",
      justification: "test",
    });
    const resultat = await refuserPropositionActualitePagesJaunes(prisma, proposition.id);
    assert.equal(resultat.statut, "refusee");
    assert.ok(resultat.decideLe);
  });

  await prisma.$disconnect();
});
