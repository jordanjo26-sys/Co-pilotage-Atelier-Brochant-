import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import dotenv from "dotenv";

// Generation de PDF a la demande par Morgane ("fais-moi un fichier" -
// demande explicite de l'utilisateur). Couvre uniquement le service : le
// contenu redige (sections) est fourni directement ici, Morgane se
// chargeant de le composer en conversation reelle.

test("genererDocumentPdf", async (t) => {
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
  const { genererDocumentPdf, DocumentGenereError, nomFichierGenereValide, cheminDocumentGenere } = await import(
    "../src/services/documentsGeneres"
  );
  const prisma = new PrismaClient();

  await t.test("titre vide -> rejette", async () => {
    await assert.rejects(genererDocumentPdf(prisma, { titre: "  ", sections: [{ paragraphes: ["x"] }] }), DocumentGenereError);
  });

  await t.test("aucune section -> rejette", async () => {
    await assert.rejects(genererDocumentPdf(prisma, { titre: "Lettre", sections: [] }), DocumentGenereError);
  });

  await t.test("genere un PDF valide, nom de fichier conforme, URL coherente", async () => {
    const resultat = await genererDocumentPdf(prisma, {
      titre: "Lettre à mon comptable",
      sections: [
        { paragraphes: ["Bonjour,", "Merci de trouver ci-joint le recapitulatif demande."] },
        { titre: "Details", puces: ["Point un", "Point deux"] },
      ],
    });

    assert.ok(nomFichierGenereValide(resultat.nomFichier), `nom de fichier invalide : ${resultat.nomFichier}`);
    assert.equal(resultat.url, `/api/documents-generes/${resultat.nomFichier}`);

    const octets = await fs.readFile(cheminDocumentGenere(resultat.nomFichier));
    assert.equal(octets.subarray(0, 5).toString("latin1"), "%PDF-");
  });

  await t.test("nomFichierGenereValide rejette un nom hors format (defense en profondeur contre un chemin invente)", () => {
    assert.equal(nomFichierGenereValide("../../etc/passwd"), false);
    assert.equal(nomFichierGenereValide("document.PDF"), false); // majuscules non attendues (slug toujours minuscule)
    assert.equal(nomFichierGenereValide("document.txt"), false);
    assert.equal(nomFichierGenereValide("lettre-abc12345.pdf"), true);
  });

  await prisma.$disconnect();
});
