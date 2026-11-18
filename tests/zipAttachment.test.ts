import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extraireTexteDepuisZip } from "../src/importers/zipAttachment";

// PDF minimal ecrit a la main (table xref volontairement vide : poppler
// (pdftotext) la reconstruit lui-meme, comme pour un vrai PDF legerement
// corrompu) - evite de dependre d'un outil de generation de PDF absent de
// l'environnement de test, tout en passant par le meme pdftotext reel que
// la production (aucun mock).
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

function construireZipDeTest(nomPdf: string): Buffer {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "zip-attachment-test-"));
  try {
    fs.writeFileSync(path.join(dossier, nomPdf), PDF_MINIMAL);
    execFileSync("zip", ["-q", "archive.zip", nomPdf], { cwd: dossier });
    return fs.readFileSync(path.join(dossier, "archive.zip"));
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
}

test("extraireTexteDepuisZip lit le texte du PDF contenu dans l'archive (ex. facture TotalEnergies cartes carburant)", () => {
  const zip = construireZipDeTest("FACPJ175002786.pdf");
  const texte = extraireTexteDepuisZip(zip);
  assert.ok(texte, "un texte aurait du etre extrait");
  assert.match(texte!, /Total HT 100,00 EUR/);
  assert.match(texte!, /Total TTC 120,00 EUR/);
});

test("extraireTexteDepuisZip retourne undefined pour une archive sans aucun PDF", () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "zip-attachment-test-"));
  try {
    fs.writeFileSync(path.join(dossier, "notice.txt"), "pas un document comptable");
    execFileSync("zip", ["-q", "archive.zip", "notice.txt"], { cwd: dossier });
    const zip = fs.readFileSync(path.join(dossier, "archive.zip"));
    assert.equal(extraireTexteDepuisZip(zip), undefined);
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});

test("extraireTexteDepuisZip retourne undefined pour des octets qui ne sont pas une archive ZIP valide (jamais d'erreur bloquante)", () => {
  assert.equal(extraireTexteDepuisZip(Buffer.from("ceci n'est pas un zip")), undefined);
});
