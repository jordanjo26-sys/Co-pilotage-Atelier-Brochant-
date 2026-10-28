/**
 * Diagnostic du standard telephonique, affiche dans les journaux de
 * deploiement (aucun acces SSH direct au serveur) : dernieres alertes
 * Twilio (erreurs de webhook vues cote Twilio), derniers appels et
 * evenements du journal applicatif lies au telephone. Lecture seule,
 * jamais bloquant.
 */
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

async function alertesTwilio(): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return console.log("Alertes Twilio : identifiants absents.");
  const reponse = await fetch("https://monitor.twilio.com/v1/Alerts?PageSize=10", {
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
  });
  if (!reponse.ok) return console.log(`Alertes Twilio : HTTP ${reponse.status}`);
  const { alerts } = (await reponse.json()) as {
    alerts: { date_created: string; error_code: string; log_level: string; request_url: string; alert_text: string }[];
  };
  console.log(`Alertes Twilio (${alerts.length}) :`);
  for (const a of alerts) {
    console.log(`- ${a.date_created} [${a.log_level}] code ${a.error_code} ${a.request_url ?? ""} :: ${(a.alert_text ?? "").slice(0, 400)}`);
  }
}

/** Derniers appels vus par Twilio : duree, statut, et requetes des webhooks (Call Events). */
async function appelsTwilio(): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return;
  const headers = { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` };
  const api = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
  const reponse = await fetch(`${api}/Calls.json?PageSize=4`, { headers });
  if (!reponse.ok) return console.log(`Appels Twilio : HTTP ${reponse.status}`);
  const { calls } = (await reponse.json()) as { calls: { sid: string; start_time: string; duration: string; status: string }[] };
  for (const c of calls) {
    console.log(`Twilio appel ${c.start_time} duree=${c.duration}s statut=${c.status}`);
    const ev = await fetch(`${api}/Calls/${c.sid}/Events.json?PageSize=20`, { headers });
    if (!ev.ok) continue;
    const { events } = (await ev.json()) as { events: { request?: { url?: string; parameters?: Record<string, string> }; response?: { response_code?: number; response_body?: string } }[] };
    for (const e of events) {
      const p = e.request?.parameters ?? {};
      const extrait = ["SessionStatus", "SessionDuration", "ErrorCode", "ErrorMessage", "HandoffData", "CallStatus"]
        .filter((k) => p[k] !== undefined)
        .map((k) => `${k}=${String(p[k]).slice(0, 120)}`)
        .join(" ");
      console.log(`   ${e.request?.url ?? "?"} -> ${e.response?.response_code ?? "?"} ${extrait} :: ${(e.response?.response_body ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
}

async function journalApplicatif(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const appels = await prisma.appel.findMany({ orderBy: { createdAt: "desc" }, take: 5 });
    for (const a of appels) {
      const transcription = a.transcription as unknown as { qui: string; texte: string; dureeMs?: number }[];
      const durees = transcription.filter((l) => typeof l.dureeMs === "number").map((l) => l.dureeMs as number);
      console.log(
        `Appel ${a.createdAt.toISOString()} statut=${a.statut} erreurs=${a.erreurs} silences=${a.silences} tours=${transcription.length} enAttente=${a.enAttente ? "oui" : "non"} sms=${a.smsUrgenceEnvoyeLe ? "oui" : "non"} notifie=${a.notifieLe ? "oui" : "non"}` +
          (durees.length ? ` reponseIA(ms) moy=${Math.round(durees.reduce((x, y) => x + y, 0) / durees.length)} max=${Math.max(...durees)} detail=${durees.join(",")}` : "")
      );
      for (const l of transcription.slice(a === appels[0] ? 0 : -4)) console.log(`   ${l.qui}: ${l.texte.slice(0, 220)}`);
    }
    const evenements = await prisma.journalEvenement.findMany({
      where: { evenement: { startsWith: "appel" } },
      orderBy: { horodatage: "desc" },
      take: 15,
    });
    for (const e of evenements) console.log(`Journal ${e.horodatage.toISOString()} ${e.evenement} :: ${(e.resultat ?? "").slice(0, 300)}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function testLatenceIA(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return console.log("Test IA : ANTHROPIC_API_KEY absente.");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { appelerIA, messageAccueil, MODELE } = await import("../src/services/standardTelephonique");
  const client = new Anthropic({ maxRetries: 0 });
  for (const essai of [1, 2]) {
    const debut = Date.now();
    const message = await appelerIA(
      client,
      [
        { role: "user", content: "[Debut d'appel - test technique.]" },
        { role: "assistant", content: messageAccueil() },
        { role: "user", content: "Bonjour, mon evier est bouche depuis ce matin." },
      ],
      15_000
    );
    const texte = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join(" ");
    console.log(
      `Test IA ${essai} (${MODELE}) : ${Date.now() - debut} ms, stop=${message.stop_reason}, cache lu=${message.usage.cache_read_input_tokens ?? 0} :: ${texte.slice(0, 160)}`
    );
  }
}

(async () => {
  await testLatenceIA().catch((err) => console.log(`Test IA en echec : ${(err as Error).message}`));
  await alertesTwilio().catch((err) => console.log(`Alertes Twilio en echec : ${(err as Error).message}`));
  await appelsTwilio().catch((err) => console.log(`Appels Twilio en echec : ${(err as Error).message}`));
  await journalApplicatif().catch((err) => console.log(`Journal applicatif en echec : ${(err as Error).message}`));
})();
