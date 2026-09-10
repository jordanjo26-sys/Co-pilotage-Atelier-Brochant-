import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execSync } from "node:child_process";
import dotenv from "dotenv";
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

// Les cas ci-dessous ne testent que les gardes-fous d'envoyerDocumentFournisseurVersDext
// qui ne necessitent pas d'appel reel a l'API Gmail (rejetes avant getGmailClient) :
// coherent avec le reste de ce fichier, qui ne mocke jamais l'API Gmail elle-meme.
test("envoi manuel vers Dext : gardes-fous", async (t) => {
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
  const { envoyerDocumentFournisseurVersDext, DocumentFournisseurEnvoiError } = await import("../src/services/gmailSync");
  const prisma = new PrismaClient();

  await t.test("document introuvable -> erreur", async () => {
    await assert.rejects(envoyerDocumentFournisseurVersDext(prisma, "inexistant"), DocumentFournisseurEnvoiError);
  });

  await t.test("type different de facture -> erreur", async () => {
    const d = await prisma.documentFournisseur.create({ data: { type: "avoir", fichierNom: "avoir.pdf" } });
    await assert.rejects(envoyerDocumentFournisseurVersDext(prisma, d.id), DocumentFournisseurEnvoiError);
  });

  await t.test("deja envoyee -> erreur", async () => {
    const d = await prisma.documentFournisseur.create({ data: { type: "facture", fichierNom: "f.pdf", statutDext: "envoye" } });
    await assert.rejects(envoyerDocumentFournisseurVersDext(prisma, d.id), DocumentFournisseurEnvoiError);
  });

  await t.test("reference Gmail manquante (document ancien) -> erreur", async () => {
    const d = await prisma.documentFournisseur.create({ data: { type: "facture", fichierNom: "f.pdf", statutDext: "a_valider" } });
    await assert.rejects(envoyerDocumentFournisseurVersDext(prisma, d.id), DocumentFournisseurEnvoiError);
  });

  await prisma.$disconnect();
});
