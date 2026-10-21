import { test } from "node:test";
import assert from "node:assert/strict";
import { genererCandidatsEmail } from "../src/services/prospection/enrichissement";

test("genererCandidatsEmail propose un email nominatif en tete quand le contact est connu", () => {
  const candidats = genererCandidatsEmail("exemple.fr", "Marie Dupont");
  assert.equal(candidats[0].email, "marie.dupont@exemple.fr");
  assert.ok(candidats.some((c) => c.email === "contact@exemple.fr"));
});

test("genererCandidatsEmail se limite aux adresses generiques sans contact connu", () => {
  const candidats = genererCandidatsEmail("exemple.fr");
  assert.deepEqual(
    candidats.map((c) => c.email),
    ["contact@exemple.fr", "info@exemple.fr"]
  );
});

test("genererCandidatsEmail normalise accents et espaces dans le nom du contact", () => {
  const candidats = genererCandidatsEmail("exemple.fr", "Éléonore de la Fontaine");
  assert.equal(candidats[0].email, "eleonore.delafontaine@exemple.fr");
});
