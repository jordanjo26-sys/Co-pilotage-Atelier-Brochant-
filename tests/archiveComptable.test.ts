import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import os from "node:os";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/(\?|$)/, "_test$1") : undefined);

if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL (ou DATABASE_URL) manquante : voir .env.example.");
}
process.env.DATABASE_URL = testDatabaseUrl;
// Pas de cle Anthropic en test : extraireChampsFacturePdf/Image doivent
// alors retomber sur "rien d'extrait" sans jamais planter (voir
// archiveComptableIA.ts) - le fichier reste importe, juste avec les seuls
// champs trouves par la regex HT/TTC (extraireMontantHTFacture/TTCFacture).
delete process.env.ANTHROPIC_API_KEY;

// Meme PDF minimal que tests/zipAttachment.test.ts, deja valide contre le
// vrai pdftotext de l'environnement de test.
const PDF_MINIMAL = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 150] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 86 >>
stream
BT /F1 12 Tf 10 100 Td (Total HT 100,00 EUR) Tj 0 -20 Td (Total TTC 120,00 EUR) Tj ET
endstream
endobj
xref
0 6
0000000000 65535 f
trailer
<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF
`;

function construireZipDeTest(fichiers: Record<string, string>): Buffer {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "archive-comptable-test-"));
  try {
    for (const [nom, contenu] of Object.entries(fichiers)) {
      fsSync.writeFileSync(path.join(dir, nom), contenu);
    }
    execFileSync("zip", ["-q", "archive.zip", ...Object.keys(fichiers)], { cwd: dir });
    return fsSync.readFileSync(path.join(dir, "archive.zip"));
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
}

async function attendreJusqua(condition: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Condition jamais remplie dans le delai imparti.");
}

test("Module Comptabilité — archive de factures", async (t) => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const {
    demarrerImportArchiveZip,
    demarrerImportFichiers,
    demarrerReextractionArchivesIncompletes,
    listerArchivesComptables,
    obtenirArchiveComptable,
    modifierArchiveComptable,
    supprimerArchiveComptable,
    archiverFactureEnvoyeeDext,
  } = await import("../src/services/archiveComptable");
  const prisma = new PrismaClient();
  const DOSSIER_ARCHIVES = path.join(__dirname, "..", "uploads", "archives-comptables");

  t.after(async () => {
    await prisma.$disconnect();
    await fs.rm(DOSSIER_ARCHIVES, { recursive: true, force: true });
  });

  await t.test("demarrerImportArchiveZip : rejette une archive sans aucun fichier reconnu", async () => {
    const zip = construireZipDeTest({ "notice.txt": "rien a importer" });
    await assert.rejects(() => demarrerImportArchiveZip(prisma, zip), /Aucun fichier/);
  });

  // Depot direct de fichiers individuels (sans ZIP) - demande explicite de
  // l'utilisateur apres un essai reel en video : sur Windows, selectionner
  // un .zip dans la boite de depot du navigateur l'ouvre parfois comme un
  // dossier navigable plutot que de le choisir comme fichier.
  await t.test("demarrerImportFichiers : rejette une liste vide", async () => {
    await assert.rejects(() => demarrerImportFichiers(prisma, []), /Aucun fichier/);
  });

  await t.test("demarrerImportFichiers : importe un PDF deja deballe, sans passer par un ZIP", async () => {
    const { total } = await demarrerImportFichiers(prisma, [{ nom: "facture-directe.pdf", donnees: Buffer.from(PDF_MINIMAL) }]);
    assert.equal(total, 1);
    await attendreJusqua(async () => (await prisma.archiveComptable.findFirst({ where: { fichierNom: "facture-directe.pdf" } })) !== null);
    const archive = await prisma.archiveComptable.findFirst({ where: { fichierNom: "facture-directe.pdf" } });
    assert.equal(archive?.montantHT, 100);
    assert.equal(archive?.montantTTC, 120);
    // Nettoyage : les sous-tests suivants (ex. le decompte exact d'archives
    // apres un import ZIP) supposent une table vide avant eux.
    await prisma.archiveComptable.delete({ where: { id: archive!.id } });
  });

  // demarrerReextractionArchivesIncompletes : une archive importee AVANT
  // un correctif de l'extraction (ex. "Montant Hors TVA", ajoute apres
  // coup) reste "a verifier" indefiniment sans ce mecanisme - demande
  // explicite de l'utilisateur (video, novembre 2026, vraie facture EDF).
  await t.test("demarrerReextractionArchivesIncompletes : complete une archive deja importee des qu'un champ redevient extractible, sans toucher aux champs deja renseignes", async () => {
    const PDF_HORS_TVA = PDF_MINIMAL.replace("Total HT 100,00 EUR", "Montant Hors TVA 27,82 EUR").replace("Total TTC 120,00 EUR", "Total TTC 33,38 EUR");
    const cheminFichier = path.join(DOSSIER_ARCHIVES, `${Date.now()}-test-edf.pdf`);
    await fs.mkdir(DOSSIER_ARCHIVES, { recursive: true });
    await fs.writeFile(cheminFichier, PDF_HORS_TVA);
    // Simule une archive importee avant que "Montant Hors TVA" ne soit
    // reconnu : HT jamais trouve a l'epoque, TTC et fournisseur deja
    // renseignes (le fournisseur a ete corrige a la main entre-temps, par
    // exemple) - ne doivent jamais etre ecrases par la re-extraction.
    const creee = await prisma.archiveComptable.create({
      data: {
        fichierNom: "test-edf.pdf",
        cheminFichier,
        mimeType: "application/pdf",
        fournisseurNom: "EDF",
        montantTTC: 33.38,
        statut: "a_verifier",
      },
    });

    const { total } = await demarrerReextractionArchivesIncompletes(prisma);
    assert.equal(total, 1);
    await attendreJusqua(async () => (await prisma.archiveComptable.findUnique({ where: { id: creee.id } }))?.statut === "complete");
    const miseAJour = await prisma.archiveComptable.findUnique({ where: { id: creee.id } });
    assert.equal(miseAJour?.montantHT, 27.82);
    assert.equal(miseAJour?.montantTTC, 33.38);
    assert.equal(miseAJour?.fournisseurNom, "EDF");
    assert.equal(miseAJour?.statut, "complete");

    await prisma.archiveComptable.delete({ where: { id: creee.id } });
  });

  await t.test("demarrerReextractionArchivesIncompletes : rien a verifier -> total 0", async () => {
    const { total } = await demarrerReextractionArchivesIncompletes(prisma);
    assert.equal(total, 0);
  });

  // Categorie comptable (CATEGORIES_FACTURE) : champ ajoute apres coup - demande
  // explicite de l'utilisateur ("classement intelligent et actif"). Une archive
  // deja "complete" (montants/fournisseur deja renseignes) mais sans categorie
  // doit elle aussi etre reprise par la re-extraction, pas seulement celles
  // "a_verifier".
  await t.test(
    "demarrerReextractionArchivesIncompletes : reprend aussi une archive deja 'complete' mais sans categorie (champ ajoute apres coup)",
    async () => {
      const cheminFichier = path.join(DOSSIER_ARCHIVES, `${Date.now()}-test-categorie.pdf`);
      await fs.mkdir(DOSSIER_ARCHIVES, { recursive: true });
      await fs.writeFile(cheminFichier, PDF_MINIMAL);
      const creee = await prisma.archiveComptable.create({
        data: {
          fichierNom: "test-categorie.pdf",
          cheminFichier,
          mimeType: "application/pdf",
          fournisseurNom: "Kiloutou",
          montantHT: 100,
          montantTTC: 120,
          statut: "complete",
          categorie: null,
        },
      });

      const dernierJournalAvant = await prisma.journalEvenement.findFirst({
        where: { evenement: "archive_comptable_reextraction_terminee" },
        orderBy: { horodatage: "desc" },
      });

      const { total } = await demarrerReextractionArchivesIncompletes(prisma);
      assert.equal(total, 1);

      await attendreJusqua(async () => {
        const dernier = await prisma.journalEvenement.findFirst({
          where: { evenement: "archive_comptable_reextraction_terminee" },
          orderBy: { horodatage: "desc" },
        });
        return dernier !== null && dernier.id !== dernierJournalAvant?.id;
      });

      // Sans cle Anthropic, rien de nouveau n'est extrait : l'archive reste
      // "complete" et sans categorie - seule compte ici qu'elle ait bien ete
      // incluse dans le lot traite (total === 1 ci-dessus).
      const inchangee = await prisma.archiveComptable.findUnique({ where: { id: creee.id } });
      assert.equal(inchangee?.statut, "complete");
      assert.equal(inchangee?.categorie, null);

      await prisma.archiveComptable.delete({ where: { id: creee.id } });
    }
  );

  await t.test("modifierArchiveComptable : accepte une categorie valide, rejette une categorie inconnue", async () => {
    const cheminFichier = path.join(DOSSIER_ARCHIVES, `${Date.now()}-test-cat-manuel.pdf`);
    await fs.mkdir(DOSSIER_ARCHIVES, { recursive: true });
    await fs.writeFile(cheminFichier, PDF_MINIMAL);
    const creee = await prisma.archiveComptable.create({
      data: { fichierNom: "test-cat-manuel.pdf", cheminFichier, mimeType: "application/pdf", montantHT: 100, montantTTC: 120, statut: "a_verifier" },
    });

    await assert.rejects(() => modifierArchiveComptable(prisma, creee.id, { categorie: "Categorie inventee" }), /Categorie invalide/);

    const corrigee = await modifierArchiveComptable(prisma, creee.id, { categorie: "Carburant" });
    assert.equal(corrigee.categorie, "Carburant");

    await prisma.archiveComptable.delete({ where: { id: creee.id } });
  });

  await t.test("listerArchivesComptables : filtre par categorie", async () => {
    const chemin1 = path.join(DOSSIER_ARCHIVES, `${Date.now()}-cat-a.pdf`);
    const chemin2 = path.join(DOSSIER_ARCHIVES, `${Date.now()}-cat-b.pdf`);
    await fs.mkdir(DOSSIER_ARCHIVES, { recursive: true });
    await fs.writeFile(chemin1, PDF_MINIMAL);
    await fs.writeFile(chemin2, PDF_MINIMAL);
    const a = await prisma.archiveComptable.create({
      data: { fichierNom: "cat-a.pdf", cheminFichier: chemin1, mimeType: "application/pdf", categorie: "Énergie", statut: "complete" },
    });
    const b = await prisma.archiveComptable.create({
      data: { fichierNom: "cat-b.pdf", cheminFichier: chemin2, mimeType: "application/pdf", categorie: "Carburant", statut: "complete" },
    });

    const energie = await listerArchivesComptables(prisma, { categorie: "Énergie" });
    assert.equal(energie.length, 1);
    assert.equal(energie[0].id, a.id);

    await prisma.archiveComptable.delete({ where: { id: a.id } });
    await prisma.archiveComptable.delete({ where: { id: b.id } });
  });

  await t.test("demarrerImportArchiveZip : importe un PDF lisible, extrait HT/TTC par regex meme sans cle IA, puis liste/filtre/corrige/supprime", async () => {
    const zip = construireZipDeTest({ "facture-test.pdf": PDF_MINIMAL });
    const { total } = await demarrerImportArchiveZip(prisma, zip);
    assert.equal(total, 1);

    await attendreJusqua(async () => (await prisma.archiveComptable.count()) === 1);
    const archives = await listerArchivesComptables(prisma);
    assert.equal(archives.length, 1);
    const archive = archives[0];
    assert.equal(archive.fichierNom, "facture-test.pdf");
    assert.equal(archive.mimeType, "application/pdf");
    assert.equal(archive.montantHT, 100);
    assert.equal(archive.montantTTC, 120);
    // Sans cle Anthropic, aucun champ ne doit avoir ete invente pour
    // fournisseur/numero/date - uniquement ce que la regex HT/TTC a trouve.
    assert.equal(archive.fournisseurNom, null);
    assert.equal(archive.statut, "a_verifier");
    await fs.access(archive.cheminFichier);

    // Filtre par montant (HT ou TTC) et par fournisseur.
    assert.equal((await listerArchivesComptables(prisma, { montantMin: 90, montantMax: 110 })).length, 1);
    assert.equal((await listerArchivesComptables(prisma, { montantMin: 500 })).length, 0);
    assert.equal((await listerArchivesComptables(prisma, { fournisseurNom: "edf" })).length, 0);

    // Correction manuelle : complete les champs manquants.
    const corrigee = await modifierArchiveComptable(prisma, archive.id, {
      fournisseurNom: "EDF Entreprises",
      dateFacture: "2026-03-15",
    });
    assert.equal(corrigee.fournisseurNom, "EDF Entreprises");
    assert.equal(corrigee.statut, "complete");
    assert.equal((await listerArchivesComptables(prisma, { fournisseurNom: "edf" })).length, 1);
    assert.equal((await listerArchivesComptables(prisma, { dateDebut: new Date("2026-01-01"), dateFin: new Date("2026-12-31") })).length, 1);

    await supprimerArchiveComptable(prisma, archive.id);
    assert.equal(await prisma.archiveComptable.count(), 0);
    await assert.rejects(() => obtenirArchiveComptable(prisma, archive.id), /introuvable/);
  });

  // archiverFactureEnvoyeeDext : copie automatique dans l'archive
  // Comptabilite au moment ou une facture part reellement vers Dext (envoi
  // automatique ou manuel, voir gmailSync.ts) - demande explicite de
  // l'utilisateur, pour ne plus jamais dependre uniquement de Dext.
  await t.test("archiverFactureEnvoyeeDext : archive avec les champs deja connus, sans relancer d'extraction", async () => {
    await archiverFactureEnvoyeeDext(prisma, {
      fichierNom: "facture-edf-envoyee.pdf",
      mimeType: "application/pdf",
      donnees: Buffer.from(PDF_MINIMAL),
      fournisseurNom: "EDF",
      numero: "FA-2026-999",
      dateFacture: new Date("2026-06-01"),
      montantHT: 100,
      montantTTC: 120,
    });

    const archive = await prisma.archiveComptable.findFirst({ where: { fichierNom: "facture-edf-envoyee.pdf" } });
    assert.ok(archive);
    assert.equal(archive?.fournisseurNom, "EDF");
    assert.equal(archive?.numero, "FA-2026-999");
    assert.equal(archive?.montantHT, 100);
    assert.equal(archive?.montantTTC, 120);
    assert.equal(archive?.statut, "complete");
    // Jamais de categorie/classifiePar devines ici : aucune extraction IA
    // n'est relancee, seuls les champs deja connus sont enregistres.
    assert.equal(archive?.categorie, null);
    assert.equal(archive?.classifiePar, null);
    await fs.access(archive!.cheminFichier);

    await prisma.archiveComptable.delete({ where: { id: archive!.id } });
  });

  await t.test("archiverFactureEnvoyeeDext : fournisseur ou montant manquant -> statut 'a_verifier'", async () => {
    await archiverFactureEnvoyeeDext(prisma, {
      fichierNom: "facture-sans-fournisseur.pdf",
      mimeType: "application/pdf",
      donnees: Buffer.from(PDF_MINIMAL),
      fournisseurNom: null,
      numero: null,
      dateFacture: null,
      montantHT: 50,
      montantTTC: 60,
    });

    const archive = await prisma.archiveComptable.findFirst({ where: { fichierNom: "facture-sans-fournisseur.pdf" } });
    assert.ok(archive);
    assert.equal(archive?.statut, "a_verifier");

    await prisma.archiveComptable.delete({ where: { id: archive!.id } });
  });
});
