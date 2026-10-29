import { gmail_v1 } from "googleapis";
import { PrismaClient } from "@prisma/client";
import { getGmailClient } from "./googleAuth";
import { extraireEntete } from "./gmailSync";

/**
 * Diagnostic ponctuel (demande explicite de l'utilisateur, apres plusieurs
 * notifications Dext "Telechargement de documents rejete" recues au
 * moment de vider le backlog de factures en attente) : au lieu de
 * demander a l'utilisateur de copier/coller chaque capture d'ecran
 * Dext une par une, lit directement ces notifications dans la boite
 * Gmail connectee (meme adresse que l'envoi vers Dext) et croise les
 * documents cites avec notre propre base, pour determiner si le rejet
 * vient d'un vrai doublon cote notre systeme ou d'un document deja
 * present sur Dext par un autre canal. Lecture seule, rien n'est
 * modifie ni renvoye.
 */

export interface DocumentRejeteDext {
  nomFichier: string;
  motif: string;
}

export interface MessageRejetDext {
  gmailMessageId: string;
  dateReception: Date | null;
  documents: DocumentRejeteDext[];
}

function extraireTexteCorps(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  if ((payload.mimeType === "text/plain" || payload.mimeType === "text/html") && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  for (const part of payload.parts || []) {
    const texte = extraireTexteCorps(part);
    if (texte) return texte;
  }
  return "";
}

// Les notifications Dext listent chaque document rejete sous la forme
// "nomfichier.pdf - <motif>. (Item #12345)" (en texte brut ou en HTML,
// d'ou le retrait prealable des balises) - approximatif par nature (lecture
// d'un e-mail tiers, pas une API documentee), mais suffisant pour un
// diagnostic sans faire saisir chaque capture d'ecran a la main.
const REGEX_LIGNE_REJET = /([\w().,'’àâäéèêëïîôöùûüçÀÂÄÉÈÊËÏÎÔÖÙÛÜÇ_-]+\.(?:pdf|jpe?g|png))\s*-\s*([^\n]+)/giu;

export async function listerRejetsDext(prisma: PrismaClient, jours = 14): Promise<MessageRejetDext[]> {
  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) {
    throw new Error("Aucune boite Gmail active (reconnexion necessaire via /auth/google).");
  }
  const { gmail } = connexionGmail;

  const liste = await gmail.users.messages.list({ userId: "me", q: `from:dext.cc newer_than:${jours}d`, maxResults: 50 });

  const resultats: MessageRejetDext[] = [];
  for (const ref of liste.data.messages ?? []) {
    if (!ref.id) continue;
    const msg = await gmail.users.messages.get({ userId: "me", id: ref.id, format: "full" });
    const sujet = extraireEntete(msg.data.payload?.headers, "Subject");
    if (!/rejet/i.test(sujet)) continue; // uniquement les notifications de rejet, pas les confirmations/autres e-mails Dext

    const corpsSansBalises = extraireTexteCorps(msg.data.payload).replace(/<[^>]+>/g, "\n");
    const documents: DocumentRejeteDext[] = [];
    const regex = new RegExp(REGEX_LIGNE_REJET);
    let correspondance: RegExpExecArray | null;
    while ((correspondance = regex.exec(corpsSansBalises))) {
      documents.push({
        nomFichier: correspondance[1],
        motif: correspondance[2].split("(Item")[0].trim().replace(/\s+/g, " "),
      });
    }

    resultats.push({
      gmailMessageId: ref.id,
      dateReception: msg.data.internalDate ? new Date(Number(msg.data.internalDate)) : null,
      documents,
    });
  }
  return resultats;
}

export interface CroisementRejetDext extends DocumentRejeteDext {
  gmailMessageId: string;
  dateNotificationRejet: Date | null;
  documentConnu: {
    id: string;
    fournisseurNom: string | null;
    dateReceptionMail: Date | null;
    statutDext: string;
    hashFichier: string | null;
  } | null;
}

/**
 * Comme listerRejetsDext, mais croise chaque document cite avec notre
 * propre base (recherche par nom de fichier) pour distinguer un vrai
 * doublon cote notre systeme (plusieurs lignes DocumentFournisseur pour
 * le meme fichier) d'un document deja present sur Dext par un autre
 * canal (une seule ligne chez nous, donc pas notre erreur).
 */
export async function diagnostiquerRejetsDext(prisma: PrismaClient, jours = 14): Promise<CroisementRejetDext[]> {
  const messages = await listerRejetsDext(prisma, jours);
  const croisements: CroisementRejetDext[] = [];

  for (const message of messages) {
    for (const doc of message.documents) {
      const correspondances = await prisma.documentFournisseur.findMany({
        where: { fichierNom: { contains: doc.nomFichier, mode: "insensitive" } },
        include: { fournisseur: { select: { nom: true } } },
        orderBy: { dateReceptionMail: "desc" },
      });
      const premier = correspondances[0];
      croisements.push({
        ...doc,
        gmailMessageId: message.gmailMessageId,
        dateNotificationRejet: message.dateReception,
        documentConnu: premier
          ? {
              id: premier.id,
              fournisseurNom: premier.fournisseur?.nom ?? null,
              dateReceptionMail: premier.dateReceptionMail,
              statutDext: premier.statutDext,
              hashFichier: premier.hashFichier,
            }
          : null,
      });
    }
  }
  return croisements;
}
