import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import dotenv from "dotenv";

// Dossier comptable : relance le rapprochement bancaire puis produit un
// PDF pret a transmettre au comptable (demande explicite de l'utilisateur,
// "rapprochement au Comptable"). Verifie a la fois l'effet de bord (le
// rapprochement est bien rejoue) et la production d'un fichier valide,
// avec et sans anomalies a signaler.

let compteur = 0;
function ref(prefixe: string): string {
  compteur += 1;
  return `${prefixe}-${compteur}`;
}

test("genererDossierComptable", async (t) => {
  dotenv.config({ path: path.join(__dirname, "..", ".env") });
  const testDatabaseUrl =
    process.env.TEST_DATABASE_URL ||
    (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/(\?|$)/, "_test$1") : undefined);
  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL (ou DATABASE_URL) manquante : voir .env.example.");
  }
  process.env.DATABASE_URL = testDatabaseUrl;
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const { genererDossierComptable } = await import("../src/services/dossierComptable");
  const { cheminDocumentGenere, nomFichierGenereValide } = await import("../src/services/documentsGeneres");
  const prisma = new PrismaClient();

  await t.test("etat vide -> PDF valide quand meme (resume a zero)", async () => {
    const resultat = await genererDossierComptable(prisma);
    assert.ok(nomFichierGenereValide(resultat.nomFichier));
    const octets = await fs.readFile(cheminDocumentGenere(resultat.nomFichier));
    assert.equal(octets.subarray(0, 5).toString("latin1"), "%PDF-");
  });

  await t.test("relance reellement le rapprochement (effet de bord), puis liste ce qui reste en attente", async () => {
    const fournisseur = await prisma.fournisseur.create({ data: { nom: ref("fournisseur-dossier") } });
    const mouvementRapprochable = await prisma.mouvementBancaire.create({
      data: { date: new Date("2026-09-10"), libelle: "VIR STRIPE", debit: 0, credit: 1000, montant: 1000, hashLigne: ref("hash") },
    });
    const payoutRapprochable = await prisma.payout.create({ data: { payoutRef: ref("po"), date: new Date("2026-09-08"), montantNet: 1000 } });

    const factureEnAttente = await prisma.factureFournisseur.create({
      data: { fournisseurId: fournisseur.id, reference: ref("fact"), echeance: new Date("2026-09-01"), montant: 321.5 },
    });
    await prisma.mouvementBancaire.create({
      data: { date: new Date("2026-09-20"), libelle: "FRAIS BANCAIRES INCONNUS", debit: 15, credit: 0, montant: -15, hashLigne: ref("hash-non-explique") },
    });

    const resultat = await genererDossierComptable(prisma);

    const payoutMaj = await prisma.payout.findUnique({ where: { id: payoutRapprochable.id } });
    assert.equal(payoutMaj?.mouvementBancaireId, mouvementRapprochable.id, "le rapprochement a bien ete rejoue par le dossier");

    const factureMaj = await prisma.factureFournisseur.findUnique({ where: { id: factureEnAttente.id } });
    assert.equal(factureMaj?.statut, "a_payer", "aucun mouvement correspondant : reste en attente, pas de supposition");

    const octets = await fs.readFile(cheminDocumentGenere(resultat.nomFichier));
    assert.equal(octets.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(octets.length > 200, "le PDF contient bien du contenu (sections remplies, pas juste un en-tete)");
  });

  await prisma.$disconnect();
});
