import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
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

test("Module Comptabilité — mois disponibles, recherche globale, espace à vérifier", async (t) => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const { listerArchivesComptables, obtenirMoisDisponiblesArchives, listerArchivesAVerifier, detecterDoublonsArchives } = await import(
    "../src/services/archiveComptable"
  );
  const prisma = new PrismaClient();
  const DOSSIER_ARCHIVES = path.join(__dirname, "..", "uploads", "archives-comptables-test-filtres");

  t.after(async () => {
    await prisma.$disconnect();
    await fs.rm(DOSSIER_ARCHIVES, { recursive: true, force: true });
  });

  async function creerArchive(data: {
    fichierNom: string;
    fournisseurNom?: string | null;
    numero?: string | null;
    dateFacture?: string | null;
    montantTTC?: number | null;
    statut?: string;
  }) {
    await fs.mkdir(DOSSIER_ARCHIVES, { recursive: true });
    const cheminFichier = path.join(DOSSIER_ARCHIVES, data.fichierNom);
    await fs.writeFile(cheminFichier, "contenu de test");
    return prisma.archiveComptable.create({
      data: {
        fichierNom: data.fichierNom,
        cheminFichier,
        mimeType: "application/pdf",
        fournisseurNom: data.fournisseurNom ?? null,
        numero: data.numero ?? null,
        dateFacture: data.dateFacture ? new Date(data.dateFacture) : null,
        montantTTC: data.montantTTC ?? null,
        statut: data.statut ?? "complete",
      },
    });
  }

  await t.test("obtenirMoisDisponiblesArchives : regroupe par mois de dateFacture (pas par import), trie du plus recent au plus ancien", async () => {
    const sep = await creerArchive({ fichierNom: "edf-sep.pdf", fournisseurNom: "EDF", dateFacture: "2026-09-15", montantTTC: 50 });
    const oct1 = await creerArchive({ fichierNom: "bouygues-oct1.pdf", fournisseurNom: "Bouygues Telecom", dateFacture: "2026-10-02", montantTTC: 60 });
    const oct2 = await creerArchive({ fichierNom: "ovh-oct2.pdf", fournisseurNom: "OVHcloud", dateFacture: "2026-10-20", montantTTC: 15 });
    const nov = await creerArchive({ fichierNom: "plateforme-nov.pdf", fournisseurNom: "La Plateforme Du Batiment", dateFacture: "2026-11-10", montantTTC: 80 });

    const mois = await obtenirMoisDisponiblesArchives(prisma);
    assert.equal(mois.length, 3);
    assert.deepEqual(mois.map((m) => m.periode), ["2026-11", "2026-10", "2026-09"]);
    assert.equal(mois.find((m) => m.periode === "2026-10")?.nombre, 2);
    assert.equal(mois.find((m) => m.periode === "2026-09")?.nombre, 1);

    for (const a of [sep, oct1, oct2, nov]) await prisma.archiveComptable.delete({ where: { id: a.id } });
  });

  await t.test("listerArchivesComptables : filtre par anneeMois selon dateFacture, pas selon la date d'import", async () => {
    const archive = await creerArchive({ fichierNom: "edf-mois.pdf", fournisseurNom: "EDF", dateFacture: "2026-10-05", montantTTC: 42 });
    // Import simule "aujourd'hui" (createdAt), facture datee d'un mois different -
    // le filtre doit suivre dateFacture, jamais createdAt.
    assert.equal((await listerArchivesComptables(prisma, { anneeMois: "2026-10" })).length, 1);
    assert.equal((await listerArchivesComptables(prisma, { anneeMois: "2026-11" })).length, 0);

    await prisma.archiveComptable.delete({ where: { id: archive.id } });
  });

  await t.test("detecterDoublonsArchives : signale un meme numero de facture chez le meme fournisseur, jamais un simple meme montant+date avec un numero different", async () => {
    const a = await creerArchive({ fichierNom: "kiloutou-1.pdf", fournisseurNom: "Kiloutou", numero: "FA-100", dateFacture: "2026-05-01", montantTTC: 120 });
    const b = await creerArchive({ fichierNom: "kiloutou-2.pdf", fournisseurNom: "Kiloutou", numero: "FA-100", dateFacture: "2026-05-01", montantTTC: 120 });
    // Meme montant+date mais numero different (ex. Pum Plastiques rencontre
    // cette session : deux factures distinctes partageant un numero de
    // compte client mal extrait) - ne doit jamais etre flague comme doublon.
    const c = await creerArchive({ fichierNom: "pum-1.pdf", fournisseurNom: "Pum Plastiques", numero: "40057638", dateFacture: "2026-06-01", montantTTC: 197.86 });
    const d = await creerArchive({ fichierNom: "pum-2.pdf", fournisseurNom: "Pum Plastiques", numero: "51810288", dateFacture: "2026-06-01", montantTTC: 62.12 });

    const raisons = detecterDoublonsArchives([a, b, c, d]);
    assert.ok(raisons.has(a.id));
    assert.ok(raisons.has(b.id));
    assert.ok(!raisons.has(c.id));
    assert.ok(!raisons.has(d.id));

    for (const arch of [a, b, c, d]) await prisma.archiveComptable.delete({ where: { id: arch.id } });
  });

  await t.test("listerArchivesAVerifier : retourne les archives incomplètes et les doublons probables, avec leur raison", async () => {
    const incomplete = await creerArchive({ fichierNom: "incomplete.pdf", fournisseurNom: null, statut: "a_verifier" });
    const doublon1 = await creerArchive({ fichierNom: "doublon-1.pdf", fournisseurNom: "Costa Immobilier", numero: "C-500", dateFacture: "2026-04-01", montantTTC: 300, statut: "complete" });
    const doublon2 = await creerArchive({ fichierNom: "doublon-2.pdf", fournisseurNom: "Costa Immobilier", numero: "C-500", dateFacture: "2026-04-01", montantTTC: 300, statut: "complete" });
    const propre = await creerArchive({ fichierNom: "propre.pdf", fournisseurNom: "WeTransfer", numero: "W-1", dateFacture: "2026-04-02", montantTTC: 10, statut: "complete" });

    const aVerifier = await listerArchivesAVerifier(prisma);
    const ids = aVerifier.map((a) => a.id);
    assert.ok(ids.includes(incomplete.id));
    assert.ok(ids.includes(doublon1.id));
    assert.ok(ids.includes(doublon2.id));
    assert.ok(!ids.includes(propre.id));
    assert.equal(aVerifier.find((a) => a.id === incomplete.id)?.raisonAVerifier, "information_manquante");
    assert.equal(aVerifier.find((a) => a.id === doublon1.id)?.raisonAVerifier, "doublon_probable");

    for (const arch of [incomplete, doublon1, doublon2, propre]) await prisma.archiveComptable.delete({ where: { id: arch.id } });
  });

  // Demande explicite de l'utilisateur : "rien qui précise si le
  // rapprochement bancaire a été fait sur cette facture ou pas" - chaque
  // archive renvoyée porte desormais un booleen "rapproche".
  await t.test("listerArchivesComptables : signale 'rapproche' aussi bien pour le lien scalaire simple que pour un reglement manuel partiel (RapprochementLigne seule)", async () => {
    const simple = await creerArchive({ fichierNom: "simple.pdf", fournisseurNom: "EDF", dateFacture: "2026-07-01", montantTTC: 50 });
    const partiel = await creerArchive({ fichierNom: "partiel.pdf", fournisseurNom: "Kiloutou", dateFacture: "2026-07-02", montantTTC: 200 });
    const jamais = await creerArchive({ fichierNom: "jamais.pdf", fournisseurNom: "OVHcloud", dateFacture: "2026-07-03", montantTTC: 15 });

    await prisma.archiveComptable.update({ where: { id: simple.id }, data: { mouvementBancaireId: "mvt-test-1" } });
    await prisma.rapprochementLigne.create({
      data: { mouvementBancaireId: "mvt-test-2", cibleType: "archive_comptable", cibleId: partiel.id, montantAffecte: 80, origine: "manuel" },
    });

    const archives = await listerArchivesComptables(prisma, { anneeMois: "2026-07" });
    assert.equal(archives.find((a) => a.id === simple.id)?.rapproche, true);
    assert.equal(archives.find((a) => a.id === partiel.id)?.rapproche, true);
    assert.equal(archives.find((a) => a.id === jamais.id)?.rapproche, false);

    for (const arch of [simple, partiel, jamais]) await prisma.archiveComptable.delete({ where: { id: arch.id } });
  });
});
