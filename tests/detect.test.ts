import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsvBuffer } from "../src/importers/csvUtils";
import { detectCsvType } from "../src/importers/detect";
import fs from "node:fs";
import path from "node:path";

const SAMPLES_DIR = path.join(__dirname, "..", "samples");

function detectSample(fichier: string) {
  const buffer = fs.readFileSync(path.join(SAMPLES_DIR, fichier));
  const { headers, normalizedHeaders } = parseCsvBuffer(buffer);
  return detectCsvType(normalizedHeaders, headers);
}

test("detecte un export de factures Synec", () => {
  const result = detectSample("synec-factures-exemple.csv");
  assert.equal(result?.mapping.type, "synec_factures");
});

test("detecte un export de clients Synec", () => {
  const result = detectSample("synec-clients-exemple.csv");
  assert.equal(result?.mapping.type, "synec_clients");
});

test("detecte un export de paiements Stripe", () => {
  const result = detectSample("stripe-paiements-exemple.csv");
  assert.equal(result?.mapping.type, "stripe_paiements");
});

test("detecte un export de payouts Stripe", () => {
  const result = detectSample("stripe-payouts-exemple.csv");
  assert.equal(result?.mapping.type, "stripe_payouts");
});

test("detecte un recapitulatif de solde Stripe", () => {
  const result = detectSample("stripe-solde-exemple.csv");
  assert.equal(result?.mapping.type, "stripe_solde");
});

test("detecte un releve bancaire", () => {
  const result = detectSample("banque-releve-exemple.csv");
  assert.equal(result?.mapping.type, "banque_releve");
});

test("retourne null pour des en-tetes non reconnus", () => {
  const { headers, normalizedHeaders } = parseCsvBuffer(Buffer.from("colonne1,colonne2\na,b\n"));
  assert.equal(detectCsvType(normalizedHeaders, headers), null);
});
