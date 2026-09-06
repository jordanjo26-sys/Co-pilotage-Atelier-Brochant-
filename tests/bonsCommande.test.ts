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

function ilYA(jours: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - jours);
  return d;
}

test("bons de commande : paiement Stripe correspondant, ambiguite, delai de grace", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { verifierBonsCommande } = await import("../src/services/bonsCommande");
  const prisma = new PrismaClient();

  async function facture(bonCommande: string, montantTTC: number, dateEmission: Date) {
    return prisma.facture.create({
      data: { reference: ref("F"), clientNom: "Client Test", montantTTC, statut: "impayee", bonCommande, dateEmission },
    });
  }
  async function paiementStripe(description: string, brut: number) {
    return prisma.paiement.create({
      data: { source: "stripe", paymentRef: ref("txn"), brut, net: brut, date: new Date(), description },
    });
  }

  await t.test("un paiement Stripe cite la reference -> facture marquee payee", async () => {
    const f = await facture("BC-1001", 500, ilYA(5));
    await paiementStripe("Commande BC-1001 - acompte travaux", 500);

    const resultat = await verifierBonsCommande(prisma);
    assert.equal(resultat.facturesPayees, 1);

    const maj = await prisma.facture.findUnique({ where: { id: f.id } });
    assert.equal(maj?.statut, "payee");
    assert.equal(maj?.montantRegle, 500);
  });

  await t.test("deux paiements citent la meme reference -> ambigu, rien de modifie", async () => {
    const f = await facture("BC-2002", 300, ilYA(5));
    await paiementStripe("Reglement BC-2002", 150);
    await paiementStripe("Solde BC-2002", 150);

    const resultat = await verifierBonsCommande(prisma);
    assert.equal(resultat.facturesAmbigues, 1);

    const maj = await prisma.facture.findUnique({ where: { id: f.id } });
    assert.equal(maj?.statut, "impayee");
    assert.equal(maj?.montantRegle, 0);
  });

  await t.test("aucun paiement trouve, emission recente -> delai de grace de 30 jours accorde", async () => {
    const emission = ilYA(5);
    const f = await facture("BC-3003", 200, emission);

    const resultat = await verifierBonsCommande(prisma);
    assert.equal(resultat.delaisAccordes, 1);

    const maj = await prisma.facture.findUnique({ where: { id: f.id } });
    assert.ok(maj?.delaiAccordeJusqua);
    const attendu = new Date(emission);
    attendu.setDate(attendu.getDate() + 30);
    assert.equal(maj!.delaiAccordeJusqua!.toDateString(), attendu.toDateString());
  });

  await t.test("emission ancienne (delai deja ecoule) -> pas de delai fixe inutilement", async () => {
    await facture("BC-4004", 200, ilYA(45));
    const resultat = await verifierBonsCommande(prisma);
    // Ne compte pas cette facture dans delaisAccordes (delai deja expire).
    const facturesAvecCeBonCommande = await prisma.facture.findMany({ where: { bonCommande: "BC-4004" } });
    assert.equal(facturesAvecCeBonCommande[0].delaiAccordeJusqua, null);
  });

  await t.test("delai deja fixe manuellement -> jamais ecrase", async () => {
    const dateManuelle = new Date("2030-01-01");
    const f = await facture("BC-5005", 200, ilYA(5));
    await prisma.facture.update({ where: { id: f.id }, data: { delaiAccordeJusqua: dateManuelle } });

    await verifierBonsCommande(prisma);

    const maj = await prisma.facture.findUnique({ where: { id: f.id } });
    assert.equal(maj?.delaiAccordeJusqua?.toISOString(), dateManuelle.toISOString());
  });

  await prisma.$disconnect();
});
