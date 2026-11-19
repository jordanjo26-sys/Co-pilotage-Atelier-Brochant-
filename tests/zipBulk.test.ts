import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extraireFichiersDepuisZip, mimeTypeDepuisNom } from "../src/importers/zipBulk";

function construireZipDeTest(fichiers: Record<string, string>): Buffer {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "zip-bulk-test-"));
  try {
    for (const [nom, contenu] of Object.entries(fichiers)) {
      const chemin = path.join(dossier, nom);
      fs.mkdirSync(path.dirname(chemin), { recursive: true });
      fs.writeFileSync(chemin, contenu);
    }
    execFileSync("zip", ["-q", "-r", "archive.zip", ...Object.keys(fichiers)], { cwd: dossier });
    return fs.readFileSync(path.join(dossier, "archive.zip"));
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
}

test("extraireFichiersDepuisZip extrait tous les PDF/JPEG/PNG, y compris dans des sous-dossiers", () => {
  const zip = construireZipDeTest({
    "2025/01/facture-edf.pdf": "contenu pdf edf",
    "2025/02/facture-sfr.jpg": "contenu jpg sfr",
    "notice.txt": "pas un document comptable",
  });

  const fichiers = extraireFichiersDepuisZip(zip);
  const noms = fichiers.map((f) => f.nom).sort();
  assert.deepEqual(noms, ["2025/01/facture-edf.pdf", "2025/02/facture-sfr.jpg"]);

  const edf = fichiers.find((f) => f.nom === "2025/01/facture-edf.pdf");
  assert.equal(edf!.donnees.toString("utf8"), "contenu pdf edf");
});

test("extraireFichiersDepuisZip retourne un tableau vide pour une archive sans fichier reconnu", () => {
  const zip = construireZipDeTest({ "lisez-moi.txt": "rien a importer" });
  assert.deepEqual(extraireFichiersDepuisZip(zip), []);
});

test("extraireFichiersDepuisZip leve une erreur explicite pour des octets qui ne sont pas une archive ZIP valide", () => {
  assert.throws(() => extraireFichiersDepuisZip(Buffer.from("ceci n'est pas un zip")), /Archive ZIP illisible/);
});

test("mimeTypeDepuisNom reconnait pdf/png/jpeg selon l'extension (jpg/jpeg par defaut)", () => {
  assert.equal(mimeTypeDepuisNom("facture.pdf"), "application/pdf");
  assert.equal(mimeTypeDepuisNom("FACTURE.PDF"), "application/pdf");
  assert.equal(mimeTypeDepuisNom("scan.png"), "image/png");
  assert.equal(mimeTypeDepuisNom("scan.jpg"), "image/jpeg");
  assert.equal(mimeTypeDepuisNom("scan.jpeg"), "image/jpeg");
});
