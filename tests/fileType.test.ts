import { test } from "node:test";
import assert from "node:assert/strict";
import { typeMimePourAffichage } from "../src/services/fileType";

// Regression reelle en production : un fournisseur envoyant via une
// plateforme tierce (dataflow@...cloud) faisait declarer un mimeType
// generique/incorrect par Gmail, forçant un telechargement au lieu d'un
// affichage quel que soit le mecanisme de previsualisation cote
// navigateur - aucun navigateur ne sait afficher "application/octet-stream"
// nativement, contrairement a "application/pdf".
test("un fichier .pdf est toujours servi en application/pdf, meme si le mimeType declare est incorrect", () => {
  assert.equal(typeMimePourAffichage("facture.pdf", "application/octet-stream"), "application/pdf");
  assert.equal(typeMimePourAffichage("facture.pdf", null), "application/pdf");
  assert.equal(typeMimePourAffichage("FACTURE.PDF", null), "application/pdf");
});

test("une image courante est reconnue par son extension", () => {
  assert.equal(typeMimePourAffichage("photo.jpg", "application/octet-stream"), "image/jpeg");
  assert.equal(typeMimePourAffichage("photo.jpeg", null), "image/jpeg");
  assert.equal(typeMimePourAffichage("logo.png", null), "image/png");
});

test("extension inconnue -> repli sur le mimeType declare", () => {
  assert.equal(typeMimePourAffichage("document.xyz", "application/vnd.custom"), "application/vnd.custom");
});

test("ni extension connue ni mimeType declare -> repli sur application/octet-stream", () => {
  assert.equal(typeMimePourAffichage("document", null), "application/octet-stream");
  assert.equal(typeMimePourAffichage(null, null), "application/octet-stream");
});
