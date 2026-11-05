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

function auJour(maintenant: Date, decalageJours: number, heure = 10): Date {
  const d = new Date(maintenant);
  d.setDate(d.getDate() + decalageJours);
  d.setHours(heure, 0, 0, 0);
  return d;
}

test("getCaSerieTemporelle : agregation par jour, mois et annee, buckets vides a zero", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { getCaSerieTemporelle } = await import("../src/services/dashboardService");
  const prisma = new PrismaClient();

  // Reference fixe (pas "maintenant" reel) : un test independant du jour ou
  // il est rejoue, meme principe que les autres tests de ce depot.
  const maintenant = new Date("2026-10-21T12:00:00");

  await prisma.facture.createMany({
    data: [
      { reference: "F-J1", clientNom: "Client A", montantTTC: 100, statut: "payee", dateEmission: auJour(maintenant, 0) },
      { reference: "F-J2", clientNom: "Client B", montantTTC: 50, statut: "payee", dateEmission: auJour(maintenant, 0, 18) },
      { reference: "F-J3", clientNom: "Client C", montantTTC: 200, statut: "payee", dateEmission: auJour(maintenant, -1) },
      // Hors fenetre des TROIS granularites (plus de 5 ans en arriere) :
      // ne doit jamais apparaitre, quelle que soit la granularite testee.
      {
        reference: "F-HORS-FENETRE",
        clientNom: "Client D",
        montantTTC: 9999,
        statut: "payee",
        dateEmission: new Date(new Date(maintenant).setFullYear(maintenant.getFullYear() - 6)),
      },
    ],
  });

  await t.test("granularite jour : agrege les deux factures du meme jour, journee sans facture a zero", async () => {
    const serie = await getCaSerieTemporelle(prisma, "jour", maintenant);
    assert.equal(serie.length, 30);

    const aujourdhui = serie.find((p) => p.periode === "2026-10-21")!;
    assert.equal(aujourdhui.montant, 150);

    const hier = serie.find((p) => p.periode === "2026-10-20")!;
    assert.equal(hier.montant, 200);

    const avantHier = serie.find((p) => p.periode === "2026-10-19")!;
    assert.equal(avantHier.montant, 0);

    assert.ok(!serie.some((p) => p.montant === 9999), "la facture hors fenetre ne doit jamais apparaitre");
  });

  await t.test("granularite mois : les trois factures du mois en cours sont agregees ensemble", async () => {
    const serie = await getCaSerieTemporelle(prisma, "mois", maintenant);
    assert.equal(serie.length, 12);
    const moisEnCours = serie.find((p) => p.periode === "2026-10")!;
    assert.equal(moisEnCours.montant, 350);
  });

  await t.test("granularite annee : toutes les factures de l'annee sont agregees ensemble", async () => {
    const serie = await getCaSerieTemporelle(prisma, "annee", maintenant);
    assert.equal(serie.length, 5);
    const anneeEnCours = serie.find((p) => p.periode === "2026")!;
    assert.equal(anneeEnCours.montant, 350);
  });

  await prisma.$disconnect();
});

test("getImpayesSerieTemporelle : regroupe par mois d'echeance, montant restant du uniquement, buckets vides a zero", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { getImpayesSerieTemporelle } = await import("../src/services/dashboardService");
  const prisma = new PrismaClient();

  const maintenant = new Date("2026-10-21T12:00:00");

  await prisma.facture.createMany({
    data: [
      // Deux impayees echues le meme mois : agregees ensemble.
      { reference: "F-IMP-1", clientNom: "Client A", montantTTC: 100, montantRegle: 0, statut: "impayee", dateEcheance: auJour(maintenant, -5) },
      { reference: "F-IMP-2", clientNom: "Client B", montantTTC: 200, montantRegle: 0, statut: "impayee", dateEcheance: auJour(maintenant, -2) },
      // Partiellement payee : seul le reste (300 - 120 = 180) doit compter.
      { reference: "F-PART", clientNom: "Client C", montantTTC: 300, montantRegle: 120, statut: "partiellement_payee", dateEcheance: auJour(maintenant, -10) },
      // Payee : ne doit jamais apparaitre, meme avec une echeance dans la fenetre.
      { reference: "F-PAYEE", clientNom: "Client D", montantTTC: 999, montantRegle: 999, statut: "payee", dateEcheance: auJour(maintenant, -1) },
      // Cloturee : ne doit jamais apparaitre non plus.
      { reference: "F-CLOT", clientNom: "Client E", montantTTC: 500, montantRegle: 0, statut: "cloturee", dateEcheance: auJour(maintenant, -3) },
      // Sans date d'echeance : exclue (rien a rattacher a un mois).
      { reference: "F-SANS-ECHEANCE", clientNom: "Client F", montantTTC: 777, montantRegle: 0, statut: "impayee" },
      // Hors fenetre des 12 mois : ne doit jamais apparaitre.
      {
        reference: "F-HORS-FENETRE",
        clientNom: "Client G",
        montantTTC: 9999,
        montantRegle: 0,
        statut: "impayee",
        dateEcheance: new Date(new Date(maintenant).setFullYear(maintenant.getFullYear() - 2)),
      },
    ],
  });

  const serie = await getImpayesSerieTemporelle(prisma, maintenant);
  assert.equal(serie.length, 12);

  const moisEnCours = serie.find((p) => p.periode === "2026-10")!;
  assert.equal(moisEnCours.montant, 100 + 200 + 180);

  const moisPrecedent = serie.find((p) => p.periode === "2026-09")!;
  assert.equal(moisPrecedent.montant, 0);

  assert.ok(!serie.some((p) => p.montant >= 500), "payee/cloturee/sans echeance/hors fenetre ne doivent jamais apparaitre");

  await prisma.$disconnect();
});
