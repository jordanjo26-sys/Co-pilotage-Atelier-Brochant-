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

async function journalApplicatif(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const appels = await prisma.appel.findMany({ orderBy: { createdAt: "desc" }, take: 3 });
    for (const a of appels) {
      const transcription = a.transcription as unknown as { qui: string; texte: string }[];
      console.log(
        `Appel ${a.createdAt.toISOString()} statut=${a.statut} erreurs=${a.erreurs} silences=${a.silences} tours=${transcription.length} enAttente=${a.enAttente ? "oui" : "non"} sms=${a.smsUrgenceEnvoyeLe ? "oui" : "non"} notifie=${a.notifieLe ? "oui" : "non"}`
      );
      for (const l of transcription.slice(-4)) console.log(`   ${l.qui}: ${l.texte.slice(0, 160)}`);
    }
    const evenements = await prisma.journalEvenement.findMany({
      where: { evenement: { startsWith: "appel" } },
      orderBy: { horodatage: "desc" },
      take: 10,
    });
    for (const e of evenements) console.log(`Journal ${e.horodatage.toISOString()} ${e.evenement} :: ${(e.resultat ?? "").slice(0, 300)}`);
  } finally {
    await prisma.$disconnect();
  }
}

(async () => {
  await alertesTwilio().catch((err) => console.log(`Alertes Twilio en echec : ${(err as Error).message}`));
  await journalApplicatif().catch((err) => console.log(`Journal applicatif en echec : ${(err as Error).message}`));
})();
