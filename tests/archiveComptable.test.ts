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
    listerArchivesComptables,
    obtenirArchiveComptable,
    modifierArchiveComptable,
    supprimerArchiveComptable,
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
});
