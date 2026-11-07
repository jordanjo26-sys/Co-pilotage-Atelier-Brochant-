import { test } from "node:test";
import assert from "node:assert/strict";

// Google Business Profile (phase fondations, lecture seule) : meme principe
// que les autres integrations optionnelles - jamais d'appel reel a
// l'API Google en test, uniquement le rejet explicite en l'absence de
// connexion Google configuree.
test("listerComptesBusinessProfile : rejet explicite si GOOGLE_CLIENT_ID/SECRET absents", async () => {
  const sauvegardeId = process.env.GOOGLE_CLIENT_ID;
  const sauvegardeSecret = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  try {
    const { listerComptesBusinessProfile, GoogleBusinessProfileError } = await import("../src/services/googleBusinessProfile");
    // La verification de configuration precede tout acces a la base :
    // aucune instance PrismaClient reelle n'est necessaire pour ce cas.
    await assert.rejects(listerComptesBusinessProfile(null as never), GoogleBusinessProfileError);
  } finally {
    if (sauvegardeId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = sauvegardeId;
    if (sauvegardeSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = sauvegardeSecret;
  }
});
