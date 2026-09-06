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

function dans(jours: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + jours);
  return d;
}
function ilYA(jours: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - jours);
  return d;
}

test("memoire a long terme (decisions) : enregistrement, filtrage, revocation", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { enregistrerDecision, listerDecisions, terminerDecision } = await import("../src/services/decisions");
  const prisma = new PrismaClient();

  await t.test("enregistre une decision et la retrouve", async () => {
    await enregistrerDecision(prisma, {
      type: "delai_accorde",
      motif: "Client en difficulte temporaire",
      auteur: "Morgane",
      objetType: "Facture",
      objetId: "F-001",
      dateFin: dans(30),
    });

    const liste = await listerDecisions(prisma, { objetType: "Facture", objetId: "F-001" });
    assert.equal(liste.length, 1);
    assert.equal(liste[0].motif, "Client en difficulte temporaire");
  });

  await t.test("activesSeulement exclut une decision deja terminee", async () => {
    const d = await enregistrerDecision(prisma, {
      type: "exception",
      motif: "Ne jamais transferer ce fournisseur automatiquement",
      auteur: "Morgane",
      objetType: "Fournisseur",
      objetId: "F-XYZ",
      dateFin: ilYA(1), // deja expiree
    });

    const actives = await listerDecisions(prisma, { objetType: "Fournisseur", objetId: "F-XYZ", activesSeulement: true });
    assert.equal(actives.length, 0);

    const toutes = await listerDecisions(prisma, { objetType: "Fournisseur", objetId: "F-XYZ", activesSeulement: false });
    assert.equal(toutes.length, 1);
    assert.equal(toutes[0].id, d.id);
  });

  await t.test("terminerDecision revoque sans supprimer", async () => {
    const d = await enregistrerDecision(prisma, {
      type: "correction",
      motif: "Test revocation",
      auteur: "Morgane",
      objetType: "Global",
      objetId: null,
      dateFin: null,
    });

    let actives = await listerDecisions(prisma, { objetType: "Global", activesSeulement: true });
    assert.ok(actives.some((a) => a.id === d.id));

    await terminerDecision(prisma, d.id);

    actives = await listerDecisions(prisma, { objetType: "Global", activesSeulement: true });
    assert.equal(actives.some((a) => a.id === d.id), false);

    const toutes = await listerDecisions(prisma, { objetType: "Global", activesSeulement: false });
    assert.ok(toutes.some((a) => a.id === d.id), "la decision reste tracee, juste terminee");
  });

  await prisma.$disconnect();
});
