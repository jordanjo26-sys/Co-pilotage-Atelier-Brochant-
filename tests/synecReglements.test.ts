import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReglements, deriveStatut } from "../src/importers/synecFactures";

test("parseReglements : cellule vide -> aucun reglement", () => {
  const r = parseReglements("");
  assert.equal(r.montantRegle, 0);
  assert.deepEqual(r.modes, []);
  assert.equal(r.oney, false);

  const r2 = parseReglements(undefined);
  assert.equal(r2.montantRegle, 0);
});

test("parseReglements : un seul reglement", () => {
  const r = parseReglements("2025-01-06 17:34:00|650,00 €|Chèque|");
  assert.equal(r.montantRegle, 650);
  assert.deepEqual(r.modes, ["Chèque"]);
  assert.equal(r.oney, false);
});

test("parseReglements : plusieurs reglements separes par ' // '", () => {
  const r = parseReglements(
    "2025-03-31 15:39:44|500,00 €|Carte| // 2025-03-31 15:39:57|437,43 €|Chèque|"
  );
  assert.ok(Math.abs(r.montantRegle - 937.43) < 0.001);
  assert.deepEqual(r.modes, ["Carte", "Chèque"]);
});

test("parseReglements : detecte un financement Oney dans le mode ou la note", () => {
  const r = parseReglements("2025-05-14 19:47:25|813,45 €|Virement|Oneybank");
  assert.equal(r.oney, true);
  assert.equal(r.montantRegle, 813.45);
});

test("parseReglements : reglement via une reference Stripe en note", () => {
  const r = parseReglements("2025-02-16 15:51:32|872,64 €|Carte|Stripe pi_3Qt9BJKxMN1fAYGf2gwFCzW5");
  assert.equal(r.montantRegle, 872.64);
  assert.deepEqual(r.modes, ["Carte"]);
  assert.equal(r.oney, false);
});

test("deriveStatut : impayee, partiellement payee, payee", () => {
  assert.equal(deriveStatut(1200, 0), "impayee");
  assert.equal(deriveStatut(1200, 500), "partiellement_payee");
  assert.equal(deriveStatut(1200, 1200), "payee");
  // Tolerance pour les arrondis de centimes.
  assert.equal(deriveStatut(1200, 1199.99), "payee");
});

test("deriveStatut : un avoir (montant negatif) sans reglement est considere solde", () => {
  assert.equal(deriveStatut(-720, 0), "payee");
});
