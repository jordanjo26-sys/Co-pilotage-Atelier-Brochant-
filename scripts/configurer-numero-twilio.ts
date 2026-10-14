/**
 * Branche le numero Twilio du standard telephonique sur les webhooks de
 * l'application (VoiceUrl, StatusCallback), directement par l'API REST
 * Twilio. Contourne la page de configuration de la console Twilio, qui
 * repond "L'objet ne peut pas etre trouve ici" pour ce numero (numero
 * "exclusif" commande par le support Twilio).
 *
 * Idempotent : rejoue a chaque deploiement (scripts/deploy/bootstrap.sh),
 * ne fait rien si les variables necessaires sont absentes, n'echoue jamais
 * le deploiement.
 *
 * Variables : TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TELEPHONE_URL_PUBLIQUE
 * (.env) et le numero en argument (format E.164, ex. +33973921009).
 */
import dotenv from "dotenv";

dotenv.config();

async function main(): Promise<void> {
  const numero = process.argv[2];
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const base = (process.env.TELEPHONE_URL_PUBLIQUE ?? "").replace(/\/$/, "");
  if (!numero || !sid || !token || !base) {
    console.log("Configuration du numero Twilio ignoree (numero, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN ou TELEPHONE_URL_PUBLIQUE manquant).");
    return;
  }

  const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
  const racine = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers`;

  const recherche = await fetch(`${racine}.json?PhoneNumber=${encodeURIComponent(numero)}`, { headers: { Authorization: auth } });
  if (!recherche.ok) throw new Error(`Recherche du numero : HTTP ${recherche.status} ${(await recherche.text()).slice(0, 300)}`);
  const { incoming_phone_numbers: numeros } = (await recherche.json()) as { incoming_phone_numbers: { sid: string }[] };
  if (numeros.length === 0) throw new Error(`Numero ${numero} introuvable sur le compte ${sid}.`);

  const reponse = await fetch(`${racine}/${numeros[0].sid}.json`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      VoiceUrl: `${base}/telephonie/entrant`,
      VoiceMethod: "POST",
      VoiceFallbackUrl: "",
      StatusCallback: `${base}/telephonie/statut`,
      StatusCallbackMethod: "POST",
    }),
  });
  if (!reponse.ok) throw new Error(`Mise a jour du numero : HTTP ${reponse.status} ${(await reponse.text()).slice(0, 300)}`);
  const resultat = (await reponse.json()) as { phone_number: string; voice_url: string; status_callback: string };
  console.log(`Numero ${resultat.phone_number} configure : voice_url=${resultat.voice_url} status_callback=${resultat.status_callback}`);
}

main().catch((err) => {
  console.error(`Configuration du numero Twilio en echec : ${(err as Error).message}`);
});
