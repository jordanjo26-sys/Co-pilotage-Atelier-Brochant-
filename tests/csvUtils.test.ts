import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHeader, parseAmount, parseFlexibleDate, detectDelimiter, parseCsvBuffer } from "../src/importers/csvUtils";

test("normalizeHeader retire accents, casse et ponctuation", () => {
  assert.equal(normalizeHeader("N° Facture"), "n facture");
  assert.equal(normalizeHeader("Date d'échéance"), "date d echeance");
  assert.equal(normalizeHeader("  Montant   TTC  "), "montant ttc");
});

test("parseAmount gere le format francais avec espaces et symbole euro", () => {
  assert.equal(parseAmount("1 234,56 €"), 1234.56);
  assert.equal(parseAmount("850.00"), 850);
  assert.equal(parseAmount("-12,50"), -12.5);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount(undefined), null);
});

test("parseAmount gere le format anglo-saxon avec virgule de milliers", () => {
  assert.equal(parseAmount("1,234.56"), 1234.56);
});

test("parseFlexibleDate lit les formats francais et ISO", () => {
  const d1 = parseFlexibleDate("02/09/2026");
  assert.equal(d1?.getFullYear(), 2026);
  assert.equal(d1?.getMonth(), 8); // 0-indexe : septembre = 8
  assert.equal(d1?.getDate(), 2);

  const d2 = parseFlexibleDate("2026-09-02 09:15:00");
  assert.equal(d2?.getFullYear(), 2026);

  assert.equal(parseFlexibleDate(""), null);
  assert.equal(parseFlexibleDate(undefined), null);
});

test("detectDelimiter choisit ; pour les exports francais et , pour Stripe", () => {
  assert.equal(detectDelimiter("N° Facture;Client;Montant TTC"), ";");
  assert.equal(detectDelimiter("id,Amount,Fee,Net"), ",");
});

test("parseCsvBuffer lit les lignes et gere le BOM", () => {
  const csv = "﻿id,Amount\nch_1,10.50\nch_2,20\n";
  const parsed = parseCsvBuffer(Buffer.from(csv, "utf8"));
  assert.deepEqual(parsed.headers, ["id", "Amount"]);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].id, "ch_1");
  assert.equal(parsed.rows[0].Amount, "10.50");
});
