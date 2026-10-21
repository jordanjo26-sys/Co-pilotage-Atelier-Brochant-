import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execSync } from "node:child_process";
import dotenv from "dotenv";
import { construireRecapMailsImportants, MailImportant } from "../src/services/mailsImportants";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/(\?|$)/, "_test$1") : undefined);

if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL (ou DATABASE_URL) manquante : voir .env.example.");
}
process.env.DATABASE_URL = testDatabaseUrl;

before(() => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });
});

test("construireRecapMailsImportants : sujet et contenu du recapitulatif", () => {
  const mails: MailImportant[] = [
    {
      gmailMessageId: "abc123",
      sujet: "Fuite d'eau urgente",
      expediteur: "Mme Martin <martin@example.com>",
      resume: "Fuite active sous l'evier, demande une intervention rapide.",
      dateReception: new Date("2026-10-21T10:00:00Z"),
    },
  ];

  const { sujet, texte } = construireRecapMailsImportants(mails);
  assert.equal(sujet, "1 mail important a traiter - Copilote Atelier Brochant");
  assert.match(texte, /Mme Martin/);
  assert.match(texte, /Fuite d'eau urgente/);
  assert.match(texte, /Fuite active sous l'evier/);
  assert.match(texte, /https:\/\/mail\.google\.com\/mail\/u\/0\/#inbox\/abc123/);
});

test("construireRecapMailsImportants : pluriel quand plusieurs mails", () => {
  const mails: MailImportant[] = [
    { gmailMessageId: "a", sujet: "A", expediteur: "a@example.com", resume: "", dateReception: null },
    { gmailMessageId: "b", sujet: "B", expediteur: "b@example.com", resume: "", dateReception: null },
  ];
  const { sujet } = construireRecapMailsImportants(mails);
  assert.equal(sujet, "2 mails importants a traiter - Copilote Atelier Brochant");
});

test("classerMailImportant : aucune cle API configuree -> erreur explicite (jamais un repli silencieux)", async () => {
  const { classerMailImportant } = await import("../src/services/mailsImportants");
  const cleOriginale = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      classerMailImportant({ sujet: "Test", expediteur: "a@example.com", extrait: "" }),
      /ANTHROPIC_API_KEY/
    );
  } finally {
    if (cleOriginale) process.env.ANTHROPIC_API_KEY = cleOriginale;
  }
});

test("verifierMailsImportants : aucune boite Gmail active -> ne leve pas d'erreur, ne fait rien", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { verifierMailsImportants } = await import("../src/services/mailsImportants");
  const prisma = new PrismaClient();

  await t.test("retourne 0/0 sans connexion Gmail", async () => {
    const resultat = await verifierMailsImportants(prisma);
    assert.deepEqual(resultat, { examines: 0, importants: 0 });
  });

  await prisma.$disconnect();
});
