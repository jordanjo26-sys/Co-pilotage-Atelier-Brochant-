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

// Validation/annulation manuelle d'un rapprochement (demande explicite de
// l'utilisateur : "permettre la validation manuelle et l'annulation
// controlee d'un rapprochement", "gerer les reglements partiels") - voir
// validerRapprochementManuel/annulerRapprochementManuel/obtenirDetailMouvement
// dans rapprochementBancaire.ts.
test("rapprochement manuel : validation (partielle et complete), annulation controlee, detail", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { validerRapprochementManuel, annulerRapprochementManuel, obtenirDetailMouvement } = await import(
    "../src/services/rapprochementBancaire"
  );
  const prisma = new PrismaClient();

  async function mouvementDebit(date: Date, montant: number) {
    return prisma.mouvementBancaire.create({
      data: { date, libelle: "PRLV MANUEL", debit: montant, credit: 0, montant: -montant, hashLigne: ref("hash-manuel") },
    });
  }
  async function archive(montantTTC: number) {
    return prisma.archiveComptable.create({
      data: { fichierNom: ref("archive") + ".pdf", cheminFichier: "/tmp/inexistant.pdf", mimeType: "application/pdf", fournisseurNom: "Test", dateFacture: new Date("2026-01-01"), montantTTC },
    });
  }

  await t.test("validation manuelle d'une seule facture qui couvre exactement le mouvement -> rapproche, pose aussi le champ scalaire", async () => {
    const m = await mouvementDebit(new Date("2026-01-10"), 100);
    const a = await archive(100);

    const resultat = await validerRapprochementManuel(prisma, m.id, [{ type: "archive_comptable", id: a.id, montantAffecte: 100 }], "Jordan");
    assert.equal(resultat.statut, "rapproche");

    const mMaj = await prisma.mouvementBancaire.findUnique({ where: { id: m.id } });
    assert.equal(mMaj?.rapprochementStatut, "rapproche");
    const aMaj = await prisma.archiveComptable.findUnique({ where: { id: a.id } });
    assert.equal(aMaj?.mouvementBancaireId, m.id);

    const historique = await prisma.rapprochementHistorique.findMany({ where: { mouvementBancaireId: m.id } });
    assert.ok(historique.some((h) => h.action === "rapproche_manuel" && h.auteur === "Jordan"));
  });

  await t.test("reglement partiel : montant affecte inferieur au montant du mouvement -> reste 'a_verifier', jamais 'rapproche'", async () => {
    const m = await mouvementDebit(new Date("2026-02-10"), 250);
    const a = await archive(250);

    const resultat = await validerRapprochementManuel(prisma, m.id, [{ type: "archive_comptable", id: a.id, montantAffecte: 100 }]);
    assert.equal(resultat.statut, "a_verifier");

    const mMaj = await prisma.mouvementBancaire.findUnique({ where: { id: m.id } });
    assert.equal(mMaj?.rapprochementStatut, "a_verifier");
    // Reglement partiel : jamais le champ scalaire (ne peut representer
    // qu'un lien 1-pour-1 complet) - uniquement RapprochementLigne.
    const aMaj = await prisma.archiveComptable.findUnique({ where: { id: a.id } });
    assert.equal(aMaj?.mouvementBancaireId, null);

    const lignes = await prisma.rapprochementLigne.findMany({ where: { mouvementBancaireId: m.id, annuleLe: null } });
    assert.equal(lignes.length, 1);
    assert.equal(lignes[0].montantAffecte, 100);
    assert.equal(lignes[0].origine, "manuel");
  });

  await t.test("deux validations successives peuvent completer un reglement partiel", async () => {
    const m = await mouvementDebit(new Date("2026-03-10"), 200);
    const a = await archive(200);

    await validerRapprochementManuel(prisma, m.id, [{ type: "archive_comptable", id: a.id, montantAffecte: 120 }]);
    let mMaj = await prisma.mouvementBancaire.findUnique({ where: { id: m.id } });
    assert.equal(mMaj?.rapprochementStatut, "a_verifier");

    const resultat2 = await validerRapprochementManuel(prisma, m.id, [{ type: "archive_comptable", id: a.id, montantAffecte: 80 }]);
    assert.equal(resultat2.statut, "rapproche");
    mMaj = await prisma.mouvementBancaire.findUnique({ where: { id: m.id } });
    assert.equal(mMaj?.rapprochementStatut, "rapproche");

    const lignes = await prisma.rapprochementLigne.findMany({ where: { mouvementBancaireId: m.id, annuleLe: null } });
    assert.equal(lignes.length, 2);
  });

  await t.test("valider un montant qui depasserait le montant reel du mouvement est refuse", async () => {
    const m = await mouvementDebit(new Date("2026-04-10"), 50);
    const a = await archive(999);

    await assert.rejects(
      () => validerRapprochementManuel(prisma, m.id, [{ type: "archive_comptable", id: a.id, montantAffecte: 999 }]),
      /dépasserait/
    );
    const mMaj = await prisma.mouvementBancaire.findUnique({ where: { id: m.id } });
    assert.equal(mMaj?.rapprochementStatut, "non_rapproche");
  });

  await t.test("annulation controlee : retire le lien, conserve la ligne (soft, jamais de delete), remet 'non_rapproche'", async () => {
    const m = await mouvementDebit(new Date("2026-05-10"), 60);
    const a = await archive(60);
    await validerRapprochementManuel(prisma, m.id, [{ type: "archive_comptable", id: a.id, montantAffecte: 60 }], "Jordan");

    await annulerRapprochementManuel(prisma, m.id, "Jordan");

    const mMaj = await prisma.mouvementBancaire.findUnique({ where: { id: m.id } });
    assert.equal(mMaj?.rapprochementStatut, "non_rapproche");
    const aMaj = await prisma.archiveComptable.findUnique({ where: { id: a.id } });
    assert.equal(aMaj?.mouvementBancaireId, null);

    // La ligne reste en base, jamais supprimee - seulement marquee annulee.
    const lignes = await prisma.rapprochementLigne.findMany({ where: { mouvementBancaireId: m.id } });
    assert.equal(lignes.length, 1);
    assert.ok(lignes[0].annuleLe !== null);
    assert.equal(lignes[0].annulePar, "Jordan");

    const historique = await prisma.rapprochementHistorique.findMany({ where: { mouvementBancaireId: m.id } });
    assert.ok(historique.some((h) => h.action === "annule_manuel"));

    // La facture redevient disponible pour un nouveau rattachement.
    const b = await archive(60);
    const resultat = await validerRapprochementManuel(prisma, m.id, [{ type: "archive_comptable", id: b.id, montantAffecte: 60 }]);
    assert.equal(resultat.statut, "rapproche");
  });

  await t.test("annuler un mouvement n'affecte jamais le lien d'un AUTRE mouvement", async () => {
    const m1 = await mouvementDebit(new Date("2026-06-10"), 40);
    const m2 = await mouvementDebit(new Date("2026-06-11"), 40);
    const a1 = await archive(40);
    const a2 = await archive(40);
    await validerRapprochementManuel(prisma, m1.id, [{ type: "archive_comptable", id: a1.id, montantAffecte: 40 }]);
    await validerRapprochementManuel(prisma, m2.id, [{ type: "archive_comptable", id: a2.id, montantAffecte: 40 }]);

    await annulerRapprochementManuel(prisma, m1.id);

    const a1Maj = await prisma.archiveComptable.findUnique({ where: { id: a1.id } });
    const a2Maj = await prisma.archiveComptable.findUnique({ where: { id: a2.id } });
    assert.equal(a1Maj?.mouvementBancaireId, null);
    assert.equal(a2Maj?.mouvementBancaireId, m2.id);
    const m2Maj = await prisma.mouvementBancaire.findUnique({ where: { id: m2.id } });
    assert.equal(m2Maj?.rapprochementStatut, "rapproche");
  });

  await t.test("obtenirDetailMouvement : renvoie la facture liee et l'historique complet", async () => {
    const m = await mouvementDebit(new Date("2026-07-10"), 77);
    const a = await archive(77);
    await validerRapprochementManuel(prisma, m.id, [{ type: "archive_comptable", id: a.id, montantAffecte: 77 }], "Jordan");

    const detail = await obtenirDetailMouvement(prisma, m.id);
    assert.equal(detail.mouvement.id, m.id);
    assert.equal(detail.cibles.length, 1);
    assert.equal(detail.cibles[0].cibleId, a.id);
    assert.equal(detail.cibles[0].montantAffecte, 77);
    assert.ok(detail.historique.length > 0);
  });

  await prisma.$disconnect();
});
