import { test } from "node:test";
import assert from "node:assert/strict";
import { gmail_v1 } from "googleapis";
import { extrairePiecesJointes } from "../src/services/gmailSync";

function part(overrides: Partial<gmail_v1.Schema$MessagePart> & { headers?: gmail_v1.Schema$MessagePartHeader[] }): gmail_v1.Schema$MessagePart {
  return {
    filename: "piece.pdf",
    mimeType: "application/pdf",
    body: { attachmentId: "abc123" },
    headers: [],
    ...overrides,
  };
}

test("retient une vraie piece jointe (sans Content-ID ni disposition inline)", () => {
  const pieces = extrairePiecesJointes(part({}));
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].nomFichier, "piece.pdf");
});

test("exclut une ressource integree via Content-ID (logo de signature)", () => {
  const pieces = extrairePiecesJointes(
    part({ filename: "logo.png", mimeType: "image/png", headers: [{ name: "Content-ID", value: "<logo123>" }] })
  );
  assert.equal(pieces.length, 0);
});

test("exclut une image de newsletter/mailing via Content-Disposition: inline (sans Content-ID)", () => {
  const pieces = extrairePiecesJointes(
    part({
      filename: "mailingassets_df1d864a92ef9fa70e9cfb8af04cb568a7259a05.jpg",
      mimeType: "image/jpeg",
      headers: [{ name: "Content-Disposition", value: "inline; filename=\"mailingassets.jpg\"" }],
    })
  );
  assert.equal(pieces.length, 0);
});

test("Content-Disposition insensible a la casse et aux espaces", () => {
  const pieces = extrairePiecesJointes(part({ headers: [{ name: "content-disposition", value: "  Inline" }] }));
  assert.equal(pieces.length, 0);
});

test("aplatit les parts imbriquees (message multipart)", () => {
  const payload: gmail_v1.Schema$MessagePart = {
    mimeType: "multipart/mixed",
    parts: [part({ filename: "facture.pdf" }), part({ filename: "logo.png", headers: [{ name: "Content-ID", value: "<x>" }] })],
  };
  const pieces = extrairePiecesJointes(payload);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].nomFichier, "facture.pdf");
});

test("ignore une part sans attachmentId ou sans nom de fichier (corps du message)", () => {
  const pieces = extrairePiecesJointes(part({ filename: "", body: {} }));
  assert.equal(pieces.length, 0);
});
