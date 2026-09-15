import { test } from "node:test";
import assert from "node:assert/strict";
import { verifierConnexionStripe } from "../src/services/stripeSync";

// Seule la branche "aucune cle configuree" est testable sans mocker le SDK
// Stripe lui-meme (jamais fait dans ce projet). Couvre la regression reelle
// visee par cette fonction : /api/stripe/status affichait "Connecté" des
// que STRIPE_API_KEY existait, meme revoquee ou invalide, sans jamais le
// verifier (signale par l'utilisateur en production : paiements absents
// alors que "le compte est connecté").
test("verifierConnexionStripe : aucune cle configuree -> non connecte avec motif explicite", async () => {
  const cleOriginale = process.env.STRIPE_API_KEY;
  delete process.env.STRIPE_API_KEY;
  try {
    const resultat = await verifierConnexionStripe();
    assert.equal(resultat.ok, false);
    if (!resultat.ok) assert.match(resultat.motif, /cle api stripe configuree/i);
  } finally {
    if (cleOriginale) process.env.STRIPE_API_KEY = cleOriginale;
  }
});
