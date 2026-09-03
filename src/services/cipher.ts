import crypto from "node:crypto";

/**
 * Chiffrement au repos des secrets sensibles (section 17 du cahier des
 * charges : "Chiffrement des secrets"). Utilise pour stocker le jeton de
 * rafraichissement Gmail : jamais en clair en base.
 *
 * Necessite la variable d'environnement ENCRYPTION_KEY : une chaine
 * hexadecimale de 64 caracteres (32 octets). La generer une fois avec :
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * et la conserver hors du depot (voir .env.example).
 */

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "ENCRYPTION_KEY manquante dans l'environnement. Generer une cle avec : " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
        "et l'ajouter au fichier .env."
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY doit faire 32 octets (64 caracteres hexadecimaux).");
  }
  return key;
}

/** Chiffre une chaine ; retourne "iv:tag:ciphertext" encode en base64. */
export function chiffrer(texteClair: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const chiffre = Buffer.concat([cipher.update(texteClair, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), chiffre.toString("base64")].join(":");
}

/** Dechiffre une chaine produite par chiffrer(). */
export function dechiffrer(texteChiffre: string): string {
  const key = getKey();
  const [ivB64, tagB64, dataB64] = texteChiffre.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Format de secret chiffre invalide.");
  }
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const clair = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return clair.toString("utf8");
}
