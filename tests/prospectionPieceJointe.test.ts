import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { enregistrerPieceJointe, supprimerPieceJointe, typeAutorise } from "../src/services/prospection/pieceJointe";

test("typeAutorise : accepte PDF/PNG/JPEG, refuse le reste", () => {
  assert.equal(typeAutorise("application/pdf"), true);
  assert.equal(typeAutorise("image/png"), true);
  assert.equal(typeAutorise("image/jpeg"), true);
  assert.equal(typeAutorise("application/x-msdownload"), false);
  assert.equal(typeAutorise("text/html"), false);
});

test("enregistrerPieceJointe : ecrit le fichier sur disque avec son contenu exact", async () => {
  const contenu = Buffer.from("plaquette commerciale fictive");
  const piece = await enregistrerPieceJointe("plaquette.pdf", "application/pdf", contenu);

  assert.equal(piece.nom, "plaquette.pdf");
  assert.equal(piece.type, "application/pdf");
  assert.ok(piece.chemin.endsWith(".pdf"));

  const relu = await fs.readFile(piece.chemin);
  assert.equal(relu.toString(), contenu.toString());

  await supprimerPieceJointe(piece.chemin);
});

test("supprimerPieceJointe : retire le fichier, jamais bloquant si deja absent", async () => {
  const piece = await enregistrerPieceJointe("a-supprimer.pdf", "application/pdf", Buffer.from("x"));
  await supprimerPieceJointe(piece.chemin);
  await assert.rejects(() => fs.readFile(piece.chemin));

  // Deuxieme suppression (fichier deja absent) : ne doit jamais lever.
  await supprimerPieceJointe(piece.chemin);
  await supprimerPieceJointe(null);
  await supprimerPieceJointe(undefined);
});
