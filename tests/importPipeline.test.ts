import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const TMP_DB = path.join(__dirname, "tmp-test.db");
process.env.DATABASE_URL = `file:${TMP_DB}`;

// Reconstruit le schema SQLite de test avant d'importer PrismaClient / le
// service d'import (qui instancient PrismaClient au chargement du module).
before(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);
  execSync("npx prisma db push --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });
});

after(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);
});

test("pipeline complet : Synec, Stripe paiements/payouts, banque", async () => {
  // Import differe apres la mise a jour du schema pour utiliser la bonne DB.
  const { PrismaClient } = await import("@prisma/client");
  const { receiveCsv } = await import("../src/services/importService");
  const { getDashboardSummary } = await import("../src/services/dashboardService");

  const prisma = new PrismaClient();
  const SAMPLES = path.join(__dirname, "..", "samples");

  const synec = await receiveCsv(
    prisma,
    "synec-factures-exemple.csv",
    fs.readFileSync(path.join(SAMPLES, "synec-factures-exemple.csv"))
  );
  assert.equal(synec.typeDetecte, "synec_factures");
  assert.equal(synec.statut, "ok");
  assert.equal(synec.nbNouveaux, 4);
  assert.equal(synec.nbErreurs, 0);

  // Reimporter le meme fichier : doit etre reconnu comme doublon de fichier.
  const synecRejoue = await receiveCsv(
    prisma,
    "synec-factures-exemple.csv",
    fs.readFileSync(path.join(SAMPLES, "synec-factures-exemple.csv"))
  );
  assert.equal(synecRejoue.statut, "doublon_fichier");

  const paiements = await receiveCsv(
    prisma,
    "stripe-paiements-exemple.csv",
    fs.readFileSync(path.join(SAMPLES, "stripe-paiements-exemple.csv"))
  );
  assert.equal(paiements.typeDetecte, "stripe_paiements");
  assert.equal(paiements.nbNouveaux, 2);

  const payouts = await receiveCsv(
    prisma,
    "stripe-payouts-exemple.csv",
    fs.readFileSync(path.join(SAMPLES, "stripe-payouts-exemple.csv"))
  );
  assert.equal(payouts.typeDetecte, "stripe_payouts");
  assert.equal(payouts.nbNouveaux, 1);

  const banque = await receiveCsv(
    prisma,
    "banque-releve-exemple.csv",
    fs.readFileSync(path.join(SAMPLES, "banque-releve-exemple.csv"))
  );
  assert.equal(banque.typeDetecte, "banque_releve");
  assert.equal(banque.nbNouveaux, 2);

  // Ventilation du payout : les 2 paiements doivent bien s'y rattacher,
  // pour un total net coherent avec le montant recu en banque (section 5).
  const paiementsDuPayout = await prisma.paiement.findMany({ where: { payoutRef: "po_1Sdemo01" } });
  assert.equal(paiementsDuPayout.length, 2);
  const netTotal = paiementsDuPayout.reduce((s, p) => s + p.net, 0);
  assert.ok(Math.abs(netTotal - 2037.65) < 0.01);

  // CA veille + impayes (critere d'acceptation V1).
  const summary = await getDashboardSummary(prisma);
  assert.ok(Math.abs(summary.caVeille - 2050) < 0.01);
  assert.equal(summary.impayes.nombre, 2);
  assert.ok(Math.abs(summary.impayes.montantTotal - 2940) < 0.01);

  await prisma.$disconnect();
});

test("un fichier au format non reconnu est marque type_inconnu, sans lever d'erreur", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { receiveCsv } = await import("../src/services/importService");
  const prisma = new PrismaClient();

  const inconnu = Buffer.from("colonne_a,colonne_b\nx,y\n");
  const result = await receiveCsv(prisma, "mystere.csv", inconnu);
  assert.equal(result.statut, "type_inconnu");
  assert.equal(result.typeDetecte, "inconnu");

  await prisma.$disconnect();
});
