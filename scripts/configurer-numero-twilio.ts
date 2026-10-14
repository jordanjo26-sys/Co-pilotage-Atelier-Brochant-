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
import { dire, echapperXml, twiml } from "../src/services/twilio";

dotenv.config();

/**
 * Messagerie de secours, hebergee par Twilio lui-meme (twimlet "echo" :
 * Twilio renvoie tel quel le TwiML passe en parametre), donc fonctionnelle
 * meme si ce serveur est totalement indisponible. Si un numero de secours
 * est configure (TELEPHONE_NUMERO_SECOURS, ex. technicien de garde),
 * l'appel y est d'abord transfere ; sinon, ou sans reponse, l'appelant
 * laisse un message vocal, recupere et envoye par e-mail des que le serveur
 * revient (src/services/messagerieSecours.ts).
 */
export function urlSecours(numeroSecours?: string): string {
  const echo = (contenu: string) => `https://twimlets.com/echo?Twiml=${encodeURIComponent(contenu)}`;
  const fin = echo(twiml(`${dire("Merci, votre message est bien enregistre. Un technicien vous rappelle dans quelques minutes. Au revoir.")}<Hangup/>`));
  const transfert = numeroSecours
    ? `${dire("Service, bonjour. Un instant, je vous mets en relation avec un technicien.")}<Dial timeout="25">${echapperXml(numeroSecours)}</Dial>`
    : "";
  return echo(
    twiml(
      transfert +
        dire(
          "Service, bonjour. Notre standard est momentanement indisponible. Laissez votre nom, votre numero, votre adresse et le motif de votre appel apres le bip : un technicien vous rappelle dans quelques minutes."
        ) +
        `<Record maxLength="180" playBeep="true" action="${echapperXml(fin)}"/>`
    )
  );
}

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
      VoiceFallbackUrl: urlSecours(process.env.TELEPHONE_NUMERO_SECOURS || undefined),
      VoiceFallbackMethod: "POST",
      StatusCallback: `${base}/telephonie/statut`,
      StatusCallbackMethod: "POST",
    }),
  });
  if (!reponse.ok) throw new Error(`Mise a jour du numero : HTTP ${reponse.status} ${(await reponse.text()).slice(0, 300)}`);
  const resultat = (await reponse.json()) as { phone_number: string; voice_url: string; status_callback: string; voice_fallback_url: string };
  console.log(`Numero ${resultat.phone_number} configure : voice_url=${resultat.voice_url} status_callback=${resultat.status_callback}`);
  console.log(
    `Messagerie de secours Twilio : ${resultat.voice_fallback_url ? "active" : "ABSENTE"}${process.env.TELEPHONE_NUMERO_SECOURS ? " (avec transfert vers le numero de secours)" : " (sans numero de secours)"}`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Configuration du numero Twilio en echec : ${(err as Error).message}`);
  });
}
