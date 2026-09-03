import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifierPieceJointe,
  choisirAdresseDext,
  extraireNumeroFacture,
  EmailAClassifier,
} from "../src/services/gmailClassify";

function email(partiel: Partial<EmailAClassifier>): EmailAClassifier {
  return { sujet: "", expediteur: "fournisseur@example.com", extraitCorps: "", piecesJointes: [], ...partiel };
}

test("classifie une facture standard (mot-cle dans le sujet)", () => {
  const e = email({ sujet: "Votre facture n°2026-014" });
  const type = classifierPieceJointe(e, { nomFichier: "document.pdf", mimeType: "application/pdf" });
  assert.equal(type, "facture");
});

test("classifie une facture standard meme sans le mot 'facture' (cas courant, section 7.4)", () => {
  const e = email({ sujet: "Votre commande chez Central Plomberie", extraitCorps: "Merci pour votre achat." });
  const type = classifierPieceJointe(e, { nomFichier: "scan0042.pdf", mimeType: "application/pdf" });
  assert.equal(type, "facture");
});

test("classifie un bon d'enlevement, jamais une facture", () => {
  const e = email({ sujet: "Bon d'enlèvement - chantier Fontainebleau" });
  const type = classifierPieceJointe(e, { nomFichier: "bon.pdf", mimeType: "application/pdf" });
  assert.equal(type, "bon_enlevement");
});

test("classifie un releve de factures fournisseur", () => {
  const e = email({ sujet: "Relevé de factures - CEDEO" });
  const type = classifierPieceJointe(e, { nomFichier: "releve_cedeo.pdf", mimeType: "application/pdf" });
  assert.equal(type, "releve");
});

test("classifie un avoir", () => {
  const e = email({ sujet: "Avoir suite a votre reclamation" });
  const type = classifierPieceJointe(e, { nomFichier: "avoir.pdf", mimeType: "application/pdf" });
  assert.equal(type, "avoir");
});

test("une piece jointe qui n'est pas un document (mimetype non gere) est ambigue", () => {
  const e = email({ sujet: "Facture" });
  const type = classifierPieceJointe(e, { nomFichier: "logo.svg", mimeType: "image/svg+xml" });
  assert.equal(type, "ambigu");
});

test("choisirAdresseDext : une seule facture -> adresse standard", () => {
  assert.equal(choisirAdresseDext(1), "facturation-brochant@dext.cc");
  assert.equal(choisirAdresseDext(0), "facturation-brochant@dext.cc");
});

test("choisirAdresseDext : plusieurs factures dans le meme e-mail -> adresse multiple", () => {
  assert.equal(choisirAdresseDext(2), "facturation-brochant@multiple.dext.cc");
});

test("extraireNumeroFacture trouve un numero apres le mot facture", () => {
  assert.equal(extraireNumeroFacture("Votre facture N°2026-014 est disponible"), "2026-014");
});

test("extraireNumeroFacture retourne null si rien de reconnaissable", () => {
  assert.equal(extraireNumeroFacture("Merci pour votre commande"), null);
});
