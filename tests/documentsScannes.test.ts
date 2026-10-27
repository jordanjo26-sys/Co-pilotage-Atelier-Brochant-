import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import dotenv from "dotenv";

// Numerisation d'un document papier depuis l'appareil photo (demande
// explicite de l'utilisateur : "je dois les scanner, mais ça sort mal").
// Couvre le chemin serveur (mise en PDF, creation du DocumentFournisseur,
// reutilisation/creation du fournisseur) - le traitement de l'image
// (recadrage, contraste) reste cote frontend et n'est pas couvert ici.

// 1x1 PNG valide (pixel transparent), suffisant pour pdfkit (doc.image) :
// aucune bibliotheque d'image necessaire pour fabriquer un fichier de test.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("enregistrerDocumentScanne", async (t) => {
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
  const { enregistrerDocumentScanne, DocumentScanneError } = await import("../src/services/documentsScannes");
  const prisma = new PrismaClient();

  await t.test("type invalide -> rejette sans rien enregistrer", async () => {
    await assert.rejects(
      enregistrerDocumentScanne(prisma, { image: PNG_1X1, type: "ambigu", fournisseurNom: "Cedeo" }),
      DocumentScanneError
    );
    await assert.rejects(
      enregistrerDocumentScanne(prisma, { image: PNG_1X1, type: "n_importe_quoi", fournisseurNom: "Cedeo" }),
      DocumentScanneError
    );
  });

  await t.test("nom de fournisseur vide -> rejette", async () => {
    await assert.rejects(
      enregistrerDocumentScanne(prisma, { image: PNG_1X1, type: "facture", fournisseurNom: "   " }),
      DocumentScanneError
    );
  });

  await t.test("facture -> en attente d'envoi a Dext, PDF valide ecrit sur disque", async () => {
    const doc = await enregistrerDocumentScanne(prisma, { image: PNG_1X1, type: "facture", fournisseurNom: "Cedeo Scan" });

    assert.equal(doc.type, "facture");
    assert.equal(doc.statutDext, "a_valider");
    assert.equal(doc.mimeType, "application/pdf");
    assert.ok(doc.cheminFichier);
    assert.ok(doc.hashFichier);

    const octets = await fs.readFile(doc.cheminFichier!);
    assert.equal(octets.subarray(0, 5).toString("latin1"), "%PDF-");

    const fournisseur = await prisma.fournisseur.findUnique({ where: { id: doc.fournisseurId! } });
    assert.equal(fournisseur?.nom, "Cedeo Scan");
    assert.equal(fournisseur?.modeReception, "papier");
  });

  await t.test("avoir/releve/devis/bon_enlevement -> archive, jamais envoye a Dext", async () => {
    for (const type of ["avoir", "releve", "devis", "bon_enlevement"]) {
      const doc = await enregistrerDocumentScanne(prisma, { image: PNG_1X1, type, fournisseurNom: "Cedeo Scan" });
      assert.equal(doc.statutDext, "archive");
    }
  });

  await t.test("meme nom de fournisseur -> meme fiche reutilisee (pas de doublon)", async () => {
    const avant = await prisma.fournisseur.count({ where: { nom: "Cedeo Scan" } });
    await enregistrerDocumentScanne(prisma, { image: PNG_1X1, type: "facture", fournisseurNom: "Cedeo Scan" });
    const apres = await prisma.fournisseur.count({ where: { nom: "Cedeo Scan" } });
    assert.equal(apres, avant);
  });

  await t.test("numero optionnel : conserve si fourni, absent sinon", async () => {
    const avecNumero = await enregistrerDocumentScanne(prisma, {
      image: PNG_1X1,
      type: "facture",
      fournisseurNom: "Cedeo Scan",
      numero: "F-2026-042",
    });
    assert.equal(avecNumero.numero, "F-2026-042");

    const sansNumero = await enregistrerDocumentScanne(prisma, { image: PNG_1X1, type: "facture", fournisseurNom: "Cedeo Scan" });
    assert.equal(sansNumero.numero, null);
  });

  await prisma.$disconnect();
});
