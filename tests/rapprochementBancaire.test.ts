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

test("rapprochement bancaire : correspondance unique, ambiguite, absence, idempotence", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { executerRapprochementBancaire } = await import("../src/services/rapprochementBancaire");
  const prisma = new PrismaClient();

  async function mouvement(date: Date, montant: number) {
    return prisma.mouvementBancaire.create({
      data: { date, libelle: "EVI STRIPE TECHNOLOGY EU", debit: 0, credit: montant, montant, hashLigne: ref("hash") },
    });
  }
  async function payout(date: Date, montantNet: number) {
    return prisma.payout.create({ data: { payoutRef: ref("po"), date, montantNet } });
  }

  await t.test("un seul mouvement candidat -> rapproche automatiquement", async () => {
    const d = new Date("2026-03-10");
    const m = await mouvement(new Date("2026-03-12"), 543.21);
    const p = await payout(d, 543.21);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.details.find((x) => x.payoutRef === p.payoutRef)?.resultat, "rapproche");

    const payoutMaj = await prisma.payout.findUnique({ where: { id: p.id } });
    const mouvementMaj = await prisma.mouvementBancaire.findUnique({ where: { id: m.id } });
    assert.equal(payoutMaj?.mouvementBancaireId, m.id);
    assert.equal(mouvementMaj?.rapprochementStatut, "rapproche");
  });

  await t.test("deux mouvements au meme montant -> ambigu, rien de rapproche", async () => {
    const d = new Date("2026-04-01");
    await mouvement(new Date("2026-04-02"), 200);
    await mouvement(new Date("2026-04-03"), 200);
    const p = await payout(d, 200);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.details.find((x) => x.payoutRef === p.payoutRef)?.resultat, "ambigu");

    const payoutMaj = await prisma.payout.findUnique({ where: { id: p.id } });
    assert.equal(payoutMaj?.mouvementBancaireId, null);
  });

  await t.test("aucun mouvement au bon montant -> sans correspondance", async () => {
    const p = await payout(new Date("2026-05-01"), 999.99);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.details.find((x) => x.payoutRef === p.payoutRef)?.resultat, "sans_correspondance");
  });

  await t.test("mouvement hors fenetre de dates (10 jours d'ecart) -> pas de rapprochement", async () => {
    await mouvement(new Date("2026-06-20"), 321.5);
    const p = await payout(new Date("2026-06-01"), 321.5);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.details.find((x) => x.payoutRef === p.payoutRef)?.resultat, "sans_correspondance");
  });

  await t.test("idempotent : rejouer ne modifie pas un payout deja rapproche", async () => {
    const d = new Date("2026-07-10");
    const m = await mouvement(new Date("2026-07-11"), 77.7);
    const p = await payout(d, 77.7);

    await executerRapprochementBancaire(prisma);
    const premierRapprochement = (await prisma.payout.findUnique({ where: { id: p.id } }))?.mouvementBancaireId;
    assert.equal(premierRapprochement, m.id);

    // Un second payout du meme montant ne doit pas voler le mouvement deja pris.
    const p2 = await payout(new Date("2026-07-10"), 77.7);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.details.find((x) => x.payoutRef === p.payoutRef), undefined, "deja rapproche, plus dans le lot a traiter");
    assert.equal(resultat.details.find((x) => x.payoutRef === p2.payoutRef)?.resultat, "sans_correspondance");
  });

  await prisma.$disconnect();
});
