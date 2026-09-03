import { PrismaClient } from "@prisma/client";
import { gmail_v1 } from "googleapis";
import MailComposer from "nodemailer/lib/mail-composer";
import { getGmailClient } from "./googleAuth";
import { classifierPieceJointe, choisirAdresseDext, extraireNumeroFacture, EmailAClassifier, PieceJointe } from "./gmailClassify";
import { sha256Hex } from "./hash";
import { logEvenement } from "./journalService";

export interface ResultatSyncGmail {
  messagesExamines: number;
  documentsTraites: number;
  documentsDoublons: number;
  documentsAmbigus: number;
  erreurs: string[];
}

interface PieceJointeExtraite extends PieceJointe {
  attachmentId: string;
}

/** Aplatit recursivement les parts MIME pour en extraire les pieces jointes. */
function extrairePiecesJointes(payload: gmail_v1.Schema$MessagePart | undefined): PieceJointeExtraite[] {
  if (!payload) return [];
  const pieces: PieceJointeExtraite[] = [];

  function visiter(part: gmail_v1.Schema$MessagePart) {
    if (part.filename && part.body?.attachmentId) {
      pieces.push({
        nomFichier: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
        attachmentId: part.body.attachmentId,
      });
    }
    (part.parts || []).forEach(visiter);
  }

  visiter(payload);
  return pieces;
}

function extraireEntete(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, nom: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === nom.toLowerCase())?.value || "";
}

/**
 * Synchronise la boite Gmail connectee : detecte les nouveaux e-mails avec
 * pieces jointes, les classifie, ecarte les doublons deja connus, transfere
 * les factures standard vers Dext, archive bons d'enlevement et releves, et
 * met en attente de validation les documents ambigus. Reprend le pipeline
 * de la section 7.2 du cahier des charges.
 *
 * Idempotent par construction (deduplication sur le hash de chaque piece
 * jointe) : peut etre appelee autant de fois que necessaire, par exemple
 * depuis un planificateur externe (cron) toutes les quelques minutes, sans
 * jamais retransmettre un document deja envoye a Dext.
 */
export async function synchroniserGmail(prisma: PrismaClient): Promise<ResultatSyncGmail> {
  const resultat: ResultatSyncGmail = {
    messagesExamines: 0,
    documentsTraites: 0,
    documentsDoublons: 0,
    documentsAmbigus: 0,
    erreurs: [],
  };

  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) {
    throw new Error("Aucune boite Gmail connectee. Se connecter via /auth/google d'abord.");
  }
  const { gmail, connexion } = connexionGmail;

  // Fenetre de recherche volontairement large (7 jours) : la deduplication
  // par hash de piece jointe rend le re-balayage de messages deja traites
  // sans consequence, et evite de manquer un message en cas d'arret
  // prolonge du service entre deux synchronisations.
  const liste = await gmail.users.messages.list({
    userId: "me",
    q: "has:attachment newer_than:7d",
    maxResults: 50,
  });

  const messages = liste.data.messages || [];

  for (const ref of messages) {
    if (!ref.id) continue;
    resultat.messagesExamines++;

    try {
      const msg = await gmail.users.messages.get({ userId: "me", id: ref.id, format: "full" });
      const headers = msg.data.payload?.headers;
      const sujet = extraireEntete(headers, "Subject");
      const expediteur = extraireEntete(headers, "From");
      const dateReception = msg.data.internalDate ? new Date(Number(msg.data.internalDate)) : null;

      const piecesBrutes = extrairePiecesJointes(msg.data.payload);
      if (piecesBrutes.length === 0) continue; // rien a router pour ce message

      const emailContexte: EmailAClassifier = {
        sujet,
        expediteur,
        extraitCorps: msg.data.snippet || "",
        piecesJointes: piecesBrutes,
      };

      const classifications = piecesBrutes.map((p) => ({ piece: p, type: classifierPieceJointe(emailContexte, p) }));
      const nbFactures = classifications.filter((c) => c.type === "facture").length;
      const adresseDext = choisirAdresseDext(nbFactures);

      for (const { piece, type } of classifications) {
        try {
          if (type === "ambigu") {
            await prisma.anomalie.create({
              data: {
                type: "document_gmail_ambigu",
                gravite: "moyenne",
                preuves: JSON.stringify({ messageId: ref.id, expediteur, sujet, fichier: piece.nomFichier }),
                actionProposee: "Examiner la piece jointe et la classer manuellement (facture, avoir, bon, releve).",
              },
            });
            resultat.documentsAmbigus++;
            continue;
          }

          const attachment = await gmail.users.messages.attachments.get({
            userId: "me",
            messageId: ref.id,
            id: piece.attachmentId,
          });
          const donnees = Buffer.from(attachment.data.data || "", "base64url");
          const hashFichier = sha256Hex(donnees);

          const existant = await prisma.documentFournisseur.findUnique({ where: { hashFichier } });
          if (existant) {
            resultat.documentsDoublons++;
            await logEvenement(prisma, {
              evenement: "gmail_document",
              action: `Piece jointe deja connue : ${piece.nomFichier}`,
              resultat: "Doublon ignore (meme empreinte de fichier).",
            });
            continue;
          }

          const numero = extraireNumeroFacture(`${sujet} ${piece.nomFichier}`);

          if (type === "facture") {
            await envoyerVersDext(gmail, { destinataire: adresseDext, nomFichier: piece.nomFichier, mimeType: piece.mimeType, donnees, sujetOrigine: sujet });
            await prisma.documentFournisseur.create({
              data: {
                type: "facture",
                fichierNom: piece.nomFichier,
                numero,
                hashFichier,
                statutDext: "envoye",
                gmailMessageId: ref.id,
                gmailExpediteur: expediteur,
                gmailObjet: sujet,
                dateReceptionMail: dateReception,
              },
            });
            await logEvenement(prisma, {
              evenement: "gmail_document",
              action: `Facture recue de ${expediteur} : ${piece.nomFichier}`,
              resultat: `Transferee automatiquement vers ${adresseDext} (cas standard, section "exception deja validee").`,
            });
          } else {
            // avoir | bon_enlevement | releve : jamais envoyes a Dext,
            // archives pour controle (sections 6.3, 6.4).
            await prisma.documentFournisseur.create({
              data: {
                type,
                fichierNom: piece.nomFichier,
                numero,
                hashFichier,
                statutDext: "archive",
                gmailMessageId: ref.id,
                gmailExpediteur: expediteur,
                gmailObjet: sujet,
                dateReceptionMail: dateReception,
              },
            });
            await logEvenement(prisma, {
              evenement: "gmail_document",
              action: `${type} recu de ${expediteur} : ${piece.nomFichier}`,
              resultat: "Archive pour controle, non transmis a Dext.",
            });
          }

          resultat.documentsTraites++;
        } catch (err) {
          resultat.erreurs.push(`${piece.nomFichier} : ${(err as Error).message}`);
        }
      }
    } catch (err) {
      resultat.erreurs.push(`Message ${ref.id} : ${(err as Error).message}`);
    }
  }

  await prisma.gmailConnexion.update({
    where: { id: connexion.id },
    data: { derniereSynchro: new Date() },
  });

  return resultat;
}

/**
 * Envoie une piece jointe vers l'adresse Dext dediee, depuis la boite
 * Gmail connectee (via l'API Gmail, jamais de mot de passe SMTP separe).
 */
async function envoyerVersDext(
  gmail: gmail_v1.Gmail,
  params: { destinataire: string; nomFichier: string; mimeType: string; donnees: Buffer; sujetOrigine: string }
) {
  const composer = new MailComposer({
    to: params.destinataire,
    subject: `Facture fournisseur - ${params.sujetOrigine}`.slice(0, 200),
    text: "Facture fournisseur transferee automatiquement par le copilote de gestion Atelier Brochant.",
    attachments: [{ filename: params.nomFichier, content: params.donnees, contentType: params.mimeType }],
  });

  const message = await composer.compile().build();
  const raw = message.toString("base64url");

  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
}
