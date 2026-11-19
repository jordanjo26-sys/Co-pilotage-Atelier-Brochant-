import { test } from "node:test";
import assert from "node:assert/strict";
import { rendrePremierePageEnImage } from "../src/importers/pdfRenderImage";

// Meme PDF minimal que tests/zipAttachment.test.ts (valide contre le vrai
// pdftotext) - ici valide contre le vrai pdftoppm (meme paquet
// poppler-utils) pour confirmer qu'une page se rend bien en PNG.
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

test("rendrePremierePageEnImage rend la premiere page d'un PDF valide en PNG", () => {
  const image = rendrePremierePageEnImage(Buffer.from(PDF_MINIMAL));
  assert.ok(image, "une image aurait du etre produite");
  // Signature PNG (8 premiers octets), independamment du contenu rendu.
  const signaturePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(image!.subarray(0, 8).equals(signaturePng), "le fichier produit doit etre un PNG valide");
});

test("rendrePremierePageEnImage retourne undefined pour des octets qui ne sont pas un PDF valide (jamais d'erreur bloquante)", () => {
  assert.equal(rendrePremierePageEnImage(Buffer.from("ceci n'est pas un pdf")), undefined);
});
