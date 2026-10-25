import { PrismaClient } from "@prisma/client";
import { finaliserAppel } from "./standardTelephonique";
import { identifiantsTwilio as identifiants } from "./twilio";

/**
 * Messagerie de secours du standard telephonique.
 *
 * Si le serveur ne repond pas a Twilio (panne, maintenance), Twilio bascule
 * sur l'URL de secours du numero (VoiceFallbackUrl, posee par
 * scripts/configurer-numero-twilio.ts) : un message vocal heberge chez
 * Twilio lui-meme, independant de ce serveur, qui enregistre le message de
 * l'appelant. Aucun appel n'est donc perdu.
 *
 * Ces enregistrements ne passent par aucune route de l'application : ce
 * module les retrouve a posteriori via l'API Twilio (des que le serveur
 * est de nouveau disponible) et les envoie par e-mail comme un compte
 * rendu d'appel ordinaire, fichier audio en piece jointe.
 */

const API = "https://api.twilio.com/2010-04-01";

/** URL du fichier audio d'un enregistrement Twilio (telechargeable avec les identifiants du compte). */
export function urlEnregistrementTwilio(sid: string, recordingSid: string): string {
  return `${API}/Accounts/${sid}/Recordings/${recordingSid}.mp3`;
}

interface EnregistrementTwilio {
  sid: string;
  call_sid: string;
  status: string;
}

export async function recupererMessagesSecours(prisma: PrismaClient, maintenant: Date = new Date()): Promise<number> {
  const id = identifiants();
  if (!id) return 0;
  const depuis = new Date(maintenant.getTime() - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const reponse = await fetch(`${API}/Accounts/${id.sid}/Recordings.json?PageSize=50&DateCreated%3E=${depuis}`, {
    headers: { Authorization: id.auth },
    signal: AbortSignal.timeout(15_000),
  });
  if (!reponse.ok) throw new Error(`Liste des enregistrements Twilio : HTTP ${reponse.status}`);
  const { recordings } = (await reponse.json()) as { recordings: EnregistrementTwilio[] };

  let nouveaux = 0;
  for (const r of recordings) {
    if (r.status !== "completed") continue;
    const existant = await prisma.appel.findUnique({ where: { callSid: r.call_sid } });
    // Enregistrement deja rattache (messagerie de l'application) : deja traite.
    if (existant?.enregistrementUrl?.includes(r.sid)) continue;
    if (existant) {
      // Appel commence normalement puis bascule sur la messagerie de secours
      // en cours de route : nouveau compte rendu, avec le message vocal.
      await prisma.appel.update({
        where: { id: existant.id },
        data: { enregistrementUrl: urlEnregistrementTwilio(id.sid, r.sid), notifieLe: null },
      });
      await finaliserAppel(prisma, r.call_sid);
      nouveaux++;
      continue;
    }

    let numeroAppelant: string | null = null;
    const appelTwilio = await fetch(`${API}/Accounts/${id.sid}/Calls/${r.call_sid}.json`, { headers: { Authorization: id.auth } });
    if (appelTwilio.ok) numeroAppelant = ((await appelTwilio.json()) as { from?: string }).from ?? null;

    await prisma.appel.create({
      data: {
        callSid: r.call_sid,
        numeroAppelant,
        statut: "termine",
        motif: "Message vocal laisse sur la messagerie de secours (standard IA momentanement indisponible).",
        enregistrementUrl: urlEnregistrementTwilio(id.sid, r.sid),
      },
    });
    await finaliserAppel(prisma, r.call_sid);
    nouveaux++;
  }
  return nouveaux;
}

/**
 * Comptes rendus d'appel jamais envoyes (ex. quota Gmail depasse au moment
 * de la fin d'appel, constate le 15/10) : renvoyes automatiquement, au plus
 * tard 5 minutes apres. Seuls les appels de moins de 3 jours sont repris.
 */
export async function renvoyerComptesRendusEnAttente(prisma: PrismaClient, maintenant: Date = new Date()): Promise<number> {
  const enAttente = await prisma.appel.findMany({
    where: {
      notifieLe: null,
      createdAt: { gte: new Date(maintenant.getTime() - 3 * 24 * 3600 * 1000), lte: new Date(maintenant.getTime() - 5 * 60 * 1000) },
    },
    take: 20,
  });
  for (const appel of enAttente) await finaliserAppel(prisma, appel.callSid);
  return enAttente.length;
}
