import crypto from "node:crypto";

/**
 * Utilitaires Twilio sans dependance au SDK Twilio : seules deux choses
 * sont necessaires (verifier qu'une requete vient bien de Twilio, et
 * produire du TwiML), toutes deux documentees et stables.
 */

/**
 * Signature X-Twilio-Signature : HMAC-SHA1 (cle = Auth Token du compte) de
 * l'URL complete appelee, suivie de chaque parametre POST (nom puis valeur)
 * tries par nom, encode en base64.
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export function signatureTwilio(authToken: string, url: string, params: Record<string, string>): string {
  const donnees = Object.keys(params)
    .sort()
    .reduce((acc, cle) => acc + cle + params[cle], url);
  return crypto.createHmac("sha1", authToken).update(Buffer.from(donnees, "utf-8")).digest("base64");
}

export function signatureTwilioValide(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signatureRecue: string | undefined
): boolean {
  if (!signatureRecue) return false;
  const attendue = Buffer.from(signatureTwilio(authToken, url, params));
  const recue = Buffer.from(signatureRecue);
  return attendue.length === recue.length && crypto.timingSafeEqual(attendue, recue);
}

export function echapperXml(texte: string): string {
  return texte
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function voix(): string {
  // Voix neuronale francaise ; surchargeable (liste dans la console Twilio,
  // Voice > Text-to-speech) sans toucher au code.
  return process.env.TELEPHONE_VOIX || "Polly.Lea-Neural";
}

export function dire(texte: string): string {
  return `<Say language="fr-FR" voice="${echapperXml(voix())}">${echapperXml(texte)}</Say>`;
}

export function twiml(contenu: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${contenu}</Response>`;
}

/** Fait parler l'agent puis ecoute la reponse de l'appelant (reconnaissance vocale Twilio). */
export function direEtEcouter(texte: string, actionUrl: string): string {
  return twiml(
    `<Gather input="speech" language="fr-FR" speechTimeout="auto" actionOnEmptyResult="true" method="POST" action="${echapperXml(actionUrl)}">` +
      dire(texte) +
      `</Gather>`
  );
}

export function direEtRaccrocher(texte: string): string {
  return twiml(`${dire(texte)}<Hangup/>`);
}

/**
 * Messagerie de secours : enregistre un message vocal si l'IA ne repond
 * plus. Apres un enregistrement, Twilio execute la reponse de actionUrl
 * (pas la suite de ce document) ; la suite ne sert que si rien n'a ete dit.
 */
export function messagerie(texte: string, actionUrl: string): string {
  return twiml(
    `${dire(texte)}<Record maxLength="120" playBeep="true" method="POST" action="${echapperXml(actionUrl)}"/>` +
      dire("Je n'ai pas entendu de message. Au revoir.") +
      `<Hangup/>`
  );
}
