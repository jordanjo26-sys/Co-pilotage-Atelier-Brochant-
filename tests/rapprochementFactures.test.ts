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

let compteur = 0;
function ref(prefixe: string): string {
  compteur += 1;
  return `${prefixe}-${compteur}`;
}

test("rapprochement paiement <-> facture : correspondance unique, ambiguite, absence, idempotence", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { rapprocherPaiementsFactures } = await import("../src/services/rapprochementFactures");
  const prisma = new PrismaClient();

  async function facture(reference: string, clientNom: string, bonCommande: string | null = null, referencesStripe: string | null = null) {
    return prisma.facture.create({
      data: { reference, clientNom, montantTTC: 100, statut: "payee", bonCommande, referencesStripe },
    });
  }
  async function paiement(description: string | null, paymentIntentRef: string | null = null) {
    return prisma.paiement.create({
      data: { source: "stripe", paymentRef: ref("pi"), brut: 100, net: 97, date: new Date(), description, paymentIntentRef },
    });
  }

  await t.test("la description cite une reference unique -> rattache", async () => {
    const f = await facture("FACTURE-1807", "Copropriété L'Orangerie");
    const p = await paiement("Paiement pour FACTURE-1807, merci");

    await rapprocherPaiementsFactures(prisma);

    const paiementMaj = await prisma.paiement.findUnique({ where: { id: p.id } });
    assert.equal(paiementMaj?.factureId, f.id);
  });

  await t.test("reference courte ne doit pas matcher a l'interieur d'une reference plus longue", async () => {
    await facture("FACTURE-180", "Client A");
    const fLongue = await facture("FACTURE-1807B", "Client B");
    const p = await paiement("Reglement FACTURE-1807B");

    await rapprocherPaiementsFactures(prisma);

    const paiementMaj = await prisma.paiement.findUnique({ where: { id: p.id } });
    assert.equal(paiementMaj?.factureId, fLongue.id);
  });

  await t.test("deux factures candidates -> ambigu, rien de rattache", async () => {
    await facture("FACTURE-9001", "Client C", "BC-777");
    await facture("FACTURE-9002", "Client D", "BC-777");
    const p = await paiement("Reference BC-777");

    const resultat = await rapprocherPaiementsFactures(prisma);

    const paiementMaj = await prisma.paiement.findUnique({ where: { id: p.id } });
    assert.equal(paiementMaj?.factureId, null);
    assert.ok(resultat.nbAmbigus >= 1);
  });

  await t.test("aucune facture ne correspond -> sans correspondance", async () => {
    const p = await paiement("Virement sans reference");
    const resultat = await rapprocherPaiementsFactures(prisma);
    const paiementMaj = await prisma.paiement.findUnique({ where: { id: p.id } });
    assert.equal(paiementMaj?.factureId, null);
    assert.ok(resultat.nbSansCorrespondance >= 1);
  });

  await t.test("description absente -> ignore, jamais traite", async () => {
    const p = await paiement(null);
    await rapprocherPaiementsFactures(prisma);
    const paiementMaj = await prisma.paiement.findUnique({ where: { id: p.id } });
    assert.equal(paiementMaj?.factureId, null);
  });

  await t.test("paymentIntentRef exact (note Synec 'Stripe pi_...') -> rattache en priorite, meme si la description pointerait ailleurs", async () => {
    const fAutre = await facture("FACTURE-7000", "Client G");
    const fCorrecte = await facture("FACTURE-7001", "Client H", null, "pi_abcDEF123");
    const p = await paiement("Mentionne par erreur FACTURE-7000 dans la description", "pi_abcDEF123");

    await rapprocherPaiementsFactures(prisma);

    const paiementMaj = await prisma.paiement.findUnique({ where: { id: p.id } });
    assert.equal(paiementMaj?.factureId, fCorrecte.id);
    assert.notEqual(paiementMaj?.factureId, fAutre.id);
  });

  await t.test("meme reference PaymentIntent sur deux factures -> ambigu", async () => {
    await facture("FACTURE-7100", "Client I", null, "pi_partage999");
    await facture("FACTURE-7101", "Client J", null, "pi_partage999");
    const p = await paiement(null, "pi_partage999");

    const resultat = await rapprocherPaiementsFactures(prisma);

    const paiementMaj = await prisma.paiement.findUnique({ where: { id: p.id } });
    assert.equal(paiementMaj?.factureId, null);
    assert.ok(resultat.nbAmbigus >= 1);
  });

  await t.test("idempotent : un paiement deja rattache n'est jamais retraite", async () => {
    const f1 = await facture("FACTURE-5001", "Client E");
    const p = await paiement("Pour FACTURE-5001");
    await rapprocherPaiementsFactures(prisma);
    assert.equal((await prisma.paiement.findUnique({ where: { id: p.id } }))?.factureId, f1.id);

    // Une seconde facture dont la reference apparaitrait aussi ne doit
    // jamais remplacer un rattachement deja fait (paiement non retraite).
    await facture("FACTURE-5001-bis", "Client F");
    await rapprocherPaiementsFactures(prisma);
    assert.equal((await prisma.paiement.findUnique({ where: { id: p.id } }))?.factureId, f1.id);
  });

  await prisma.$disconnect();
});
