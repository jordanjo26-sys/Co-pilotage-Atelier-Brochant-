import { test, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

before(() => {
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
});

test("chiffrer/dechiffrer : aller-retour fidele", async () => {
  const { chiffrer, dechiffrer } = await import("../src/services/cipher");
  const secret = "refresh-token-tres-secret-1234567890";
  const chiffre = chiffrer(secret);

  assert.notEqual(chiffre, secret);
  assert.equal(dechiffrer(chiffre), secret);
});

test("chiffrer : deux chiffrements du meme texte donnent des resultats differents (IV aleatoire)", async () => {
  const { chiffrer } = await import("../src/services/cipher");
  const a = chiffrer("meme-secret");
  const b = chiffrer("meme-secret");
  assert.notEqual(a, b);
});

test("dechiffrer : rejette un texte altere (integrite garantie par le tag GCM)", async () => {
  const { chiffrer, dechiffrer } = await import("../src/services/cipher");
  const chiffre = chiffrer("valeur-integrite");
  const [iv, tag, data] = chiffre.split(":");
  const dataAlteree = Buffer.from(data, "base64");
  dataAlteree[0] ^= 0xff;
  const altere = [iv, tag, dataAlteree.toString("base64")].join(":");

  assert.throws(() => dechiffrer(altere));
});
