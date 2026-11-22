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

// Demande explicite de l'utilisateur : un reglement bancaire peut couvrir
// plusieurs factures a la fois (debit) - decision fixee : seul un ensemble
// UNIQUE de factures en somme exacte est rapproche automatiquement, jamais
// un montant partiel devine (voir rapprochementBancaire.ts, nouvelle passe
// "Reglements partiels / multi-factures").
test("rapprochement bancaire : reglements multi-factures et partiels (debit)", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { executerRapprochementBancaire } = await import("../src/services/rapprochementBancaire");
  const prisma = new PrismaClient();

  async function mouvementDebit(date: Date, montant: number) {
    return prisma.mouvementBancaire.create({
      data: { date, libelle: "PRLV MULTI", debit: montant, credit: 0, montant: -montant, hashLigne: ref("hash-multi") },
    });
  }
  async function archive(dateFacture: Date, montantTTC: number) {
    return prisma.archiveComptable.create({
      data: { fichierNom: ref("archive") + ".pdf", cheminFichier: "/tmp/inexistant.pdf", mimeType: "application/pdf", fournisseurNom: "Kiloutou", dateFacture, montantTTC },
    });
  }
  async function document(date: Date, montantTTC: number) {
    return prisma.documentFournisseur.create({ data: { type: "facture", fichierNom: ref("doc") + ".pdf", date, montantTTC } });
  }

  await t.test("deux factures (une archive + un document) dont la somme egale exactement un mouvement -> rapprochees toutes les deux", async () => {
    const a = await archive(new Date("2026-01-05"), 45);
    const d = await document(new Date("2026-01-06"), 78.5);
    const m = await mouvementDebit(new Date("2026-01-10"), 123.5);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.nbRapprochesMultiFactures, 1);

    const aMaj = await prisma.archiveComptable.findUnique({ where: { id: a.id } });
    const dMaj = await prisma.documentFournisseur.findUnique({ where: { id: d.id } });
    const mMaj = await prisma.mouvementBancaire.findUnique({ where: { id: m.id } });
    assert.equal(aMaj?.mouvementBancaireId, m.id);
    assert.equal(dMaj?.mouvementBancaireId, m.id);
    assert.equal(mMaj?.rapprochementStatut, "rapproche");

    const lignes = await prisma.rapprochementLigne.findMany({ where: { mouvementBancaireId: m.id } });
    assert.equal(lignes.length, 2);
    assert.ok(lignes.every((l) => l.origine === "auto_exact"));
  });

  await t.test("deux combinaisons differentes sommant au meme montant -> ambigu, jamais de pari automatique", async () => {
    // 60+40 OU 70+30 : deux sous-ensembles distincts egalent 100 - aucun des
    // 4 montants ne correspond seul a une autre facture/un autre mouvement,
    // pour que ce soit bien LA NOUVELLE passe multi-factures qui detecte
    // l'ambiguite (et non une des passes a correspondance simple, qui
    // s'executent avant elle).
    const a1 = await archive(new Date("2026-02-01"), 60);
    const a2 = await archive(new Date("2026-02-02"), 40);
    const a3 = await archive(new Date("2026-02-03"), 70);
    const a4 = await archive(new Date("2026-02-04"), 30);
    const m = await mouvementDebit(new Date("2026-02-10"), 100);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.nbAmbigusMultiFactures, 1);

    const mMaj = await prisma.mouvementBancaire.findUnique({ where: { id: m.id } });
    assert.equal(mMaj?.rapprochementStatut, "a_verifier");
    for (const a of [a1, a2, a3, a4]) {
      const aMaj = await prisma.archiveComptable.findUnique({ where: { id: a.id } });
      assert.equal(aMaj?.mouvementBancaireId, null);
    }

    const historique = await prisma.rapprochementHistorique.findMany({ where: { mouvementBancaireId: m.id } });
    assert.ok(historique.some((h) => h.action === "ambigu"));
  });

  await t.test("reglement reellement partiel (aucun sous-ensemble exact) -> jamais de rapprochement automatique devine", async () => {
    await archive(new Date("2026-03-01"), 250); // seule facture disponible dans la fenetre, bien plus chere que le mouvement
    const m = await mouvementDebit(new Date("2026-03-05"), 100);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.nbRapprochesMultiFactures, 0);
    assert.equal(resultat.nbAmbigusMultiFactures, 0);

    const mMaj = await prisma.mouvementBancaire.findUnique({ where: { id: m.id } });
    assert.equal(mMaj?.rapprochementStatut, "non_rapproche");

    const lignes = await prisma.rapprochementLigne.findMany({ where: { mouvementBancaireId: m.id } });
    assert.equal(lignes.length, 0);
  });

  await t.test("idempotent : rejouer ne touche plus un mouvement deja rapproche par la passe multi-factures", async () => {
    const a = await archive(new Date("2026-04-01"), 30);
    const d = await document(new Date("2026-04-02"), 70);
    const m = await mouvementDebit(new Date("2026-04-05"), 100);

    await executerRapprochementBancaire(prisma);
    const resultat2 = await executerRapprochementBancaire(prisma);
    assert.equal(resultat2.nbRapprochesMultiFactures, 0);

    const lignes = await prisma.rapprochementLigne.findMany({ where: { mouvementBancaireId: m.id } });
    assert.equal(lignes.length, 2);
    void a;
    void d;
  });

  await prisma.$disconnect();
});
