import { test } from "node:test";
import assert from "node:assert/strict";
import { synecEstConfigure } from "../src/services/synecSync";

// Comme pour Stripe, seule la detection de presence des identifiants est
// testable sans lancer un vrai navigateur headless (jamais fait dans ce
// projet). synchroniserSynec/verifierConnexionSynec ne sont donc pas
// couverts ici.
test("synecEstConfigure : faux tant qu'un des trois identifiants manque", () => {
  const valeursOriginales = {
    url: process.env.SYNEC_URL,
    identifiant: process.env.SYNEC_IDENTIFIANT,
    motDePasse: process.env.SYNEC_MOT_DE_PASSE,
  };
  try {
    delete process.env.SYNEC_URL;
    delete process.env.SYNEC_IDENTIFIANT;
    delete process.env.SYNEC_MOT_DE_PASSE;
    assert.equal(synecEstConfigure(), false);

    process.env.SYNEC_URL = "https://app.synec.io/";
    process.env.SYNEC_IDENTIFIANT = "test";
    assert.equal(synecEstConfigure(), false);

    process.env.SYNEC_MOT_DE_PASSE = "test";
    assert.equal(synecEstConfigure(), true);
  } finally {
    for (const [cle, valeur] of Object.entries({
      SYNEC_URL: valeursOriginales.url,
      SYNEC_IDENTIFIANT: valeursOriginales.identifiant,
      SYNEC_MOT_DE_PASSE: valeursOriginales.motDePasse,
    })) {
      if (valeur === undefined) delete process.env[cle];
      else process.env[cle] = valeur;
    }
  }
});
