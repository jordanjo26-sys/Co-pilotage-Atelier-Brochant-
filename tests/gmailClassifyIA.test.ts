import { test } from "node:test";
import assert from "node:assert/strict";
import { classifierParIA } from "../src/services/gmailClassifyIA";

// Seule la branche "aucune cle configuree" est testable sans mocker le SDK
// Anthropic lui-meme (jamais fait dans ce projet, voir tests/morgane -
// inexistant pour la meme raison). Couvre le comportement de repli
// attendu : sans avis fiable, le document retombe sur "ambigu" comme
// avant l'introduction de ce filet de securite, jamais une erreur qui
// remonterait et interromprait la synchronisation Gmail.
test("classifierParIA : aucune cle configuree -> null (repli silencieux)", async () => {
  const cleOriginale = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const resultat = await classifierParIA("Sujet : Votre facture\nContenu : facture n°123");
    assert.equal(resultat, null);
  } finally {
    if (cleOriginale) process.env.ANTHROPIC_API_KEY = cleOriginale;
  }
});

test("classifierParIA : texte vide -> null sans appel", async () => {
  process.env.ANTHROPIC_API_KEY = "cle-de-test-non-valide";
  try {
    const resultat = await classifierParIA("   ");
    assert.equal(resultat, null);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
