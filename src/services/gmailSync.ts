import { PrismaClient } from "@prisma/client";
import { gmail_v1 } from "googleapis";
import MailComposer from "nodemailer/lib/mail-composer";
import { getGmailClient } from "./googleAuth";
import { classifierPieceJointe, choisirAdresseDext, extraireNumeroFacture, EmailAClassifier, PieceJointe, TypeDocument } from "./gmailClassify";
import { sha256Hex } from "./hash";
import { logEvenement } from "./journalService";
import { resoudreFournisseur, extraireIdentiteExpediteur } from "./fournisseurs";
import { controlerReleveFournisseur } from "./controleReleves";
import { extractPdfText } from "../importers/bankStatementPdf";

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

/**
 * Aplatit recursivement les parts MIME pour en extraire les pieces jointes.
 * Exclut les ressources integrees au corps du message (logo de signature,
 * icones de reseaux sociaux, images de newsletter/mailing...) : elles
 * portent techniquement un nom de fichier et un attachmentId comme une
 * vraie piece jointe, mais se reconnaissent a deux signaux standards :
 *  - un en-tete Content-ID, qui sert a les referencer depuis le HTML du
 *    message (`<img src="cid:...">`) ;
 *  - un Content-Disposition "inline" (par opposition a "attachment"),
 *    utilise par la plupart des plateformes d'e-mailing pour leurs images
 *    de template meme sans Content-ID (constate en production : images
 *    "mailingassets_..." et images heergees par Google, sans Content-ID
 *    mais explicitement en disposition inline).
 * Ces deux en-tetes sont les signaux les plus fiables et universels pour
 * distinguer une ressource de mise en forme d'un vrai document envoye par
 * l'expediteur.
 */
export function extrairePiecesJointes(payload: gmail_v1.Schema$MessagePart | undefined): PieceJointeExtraite[] {
  if (!payload) return [];
  const pieces: PieceJointeExtraite[] = [];

  function visiter(part: gmail_v1.Schema$MessagePart) {
    const estIntegree = Boolean(extraireEntete(part.headers, "Content-ID"));
    const disposition = extraireEntete(part.headers, "Content-Disposition").trim().toLowerCase();
    const estInline = disposition.startsWith("inline");
    if (part.filename && part.body?.attachmentId && !estIntegree && !estInline) {
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
 * Interrupteur de securite (section 16 : prudence en cas de doute) :
 * transfert automatique des factures vers Dext desactivable sans toucher
 * au code, via la variable d'environnement DEXT_AUTO_FORWARD. Quand
 * desactive (valeur "false"), les factures sont etiquetees dans Gmail par
 * mois de reception plutot que transmises, pour un envoi manuel groupe en
 * fin de mois le temps d'observer le comportement du systeme.
 */
function transfertAutomatiqueActif(): boolean {
  return process.env.DEXT_AUTO_FORWARD !== "false";
}

/** Nom du libelle Gmail (hierarchique) pour le mois de reception donne. */
function nomEtiquetteFacturesDuMois(date: Date): string {
  const moisAnnee = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(date);
  const capitalise = moisAnnee.charAt(0).toUpperCase() + moisAnnee.slice(1);
  return `Copilote/Factures a transferer/${capitalise}`;
}

/**
 * Retrouve un libelle Gmail existant par son nom ou le cree s'il n'existe
 * pas encore (les libelles imbriques du type "Parent/Enfant" sont crees
 * automatiquement par l'API sans que le parent doive prealablement
 * exister). Met en cache le resultat pour la duree d'une synchronisation,
 * un meme libelle (le mois en cours) etant reutilise pour tous les
 * messages traites lors du meme passage.
 */
async function obtenirOuCreerLabel(gmail: gmail_v1.Gmail, nom: string, cache: Map<string, string>): Promise<string> {
  const enCache = cache.get(nom);
  if (enCache) return enCache;

  const liste = await gmail.users.labels.list({ userId: "me" });
  const existant = liste.data.labels?.find((l) => l.name === nom);
  if (existant?.id) {
    cache.set(nom, existant.id);
    return existant.id;
  }

  const cree = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name: nom, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  const id = cree.data.id;
  if (!id) throw new Error(`Echec de creation du libelle Gmail "${nom}"`);
  cache.set(nom, id);
  return id;
}

/**
 * Synchronise la boite Gmail connectee : detecte les nouveaux e-mails avec
 * pieces jointes, les classifie, ecarte les doublons deja connus, transfere
 * les factures standard vers Dext (sauf pause via DEXT_AUTO_FORWARD, voir
 * plus bas), archive bons d'enlevement, releves et devis, et met en
 * attente de validation les documents ambigus. Reprend le pipeline de la
 * section 7.2 du cahier des charges.
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
  // prolonge du service entre deux synchronisations. On exclut d'office les
  // e-mails de Dext lui-meme (accuses de reception, recapitulatif
  // quotidien) : ce sont des notifications sortantes de Dext, jamais des
  // documents fournisseurs a router.
  const liste = await gmail.users.messages.list({
    userId: "me",
    q: "has:attachment newer_than:7d -from:dext.cc",
    maxResults: 50,
  });

  const messages = liste.data.messages || [];
  const cacheLabels = new Map<string, string>();
  const cacheFournisseurs = new Map<string, string>();

  for (const ref of messages) {
    if (!ref.id) continue;
    resultat.messagesExamines++;

    try {
      const msg = await gmail.users.messages.get({ userId: "me", id: ref.id, format: "full" });
      const headers = msg.data.payload?.headers;
      const sujet = extraireEntete(headers, "Subject");
      const expediteur = extraireEntete(headers, "From");
      const dateReception = msg.data.internalDate ? new Date(Number(msg.data.internalDate)) : null;

      // Filet de securite en plus du "-from:dext.cc" de la recherche
      // (au cas ou Dext changerait un jour de sous-domaine d'envoi) :
      // jamais retraiter un e-mail dont l'expediteur est Dext.
      if (expediteur.toLowerCase().includes("dext.cc")) continue;

      const piecesBrutes = extrairePiecesJointes(msg.data.payload);
      if (piecesBrutes.length === 0) continue; // rien a router pour ce message

      const emailContexte: EmailAClassifier = {
        sujet,
        expediteur,
        extraitCorps: msg.data.snippet || "",
        piecesJointes: piecesBrutes,
      };

      // Phase 1 : telecharger chaque piece, ecarter les doublons deja
      // connus, puis classifier — en lisant le CONTENU d'un PDF (pas
      // seulement le sujet/corps/nom de fichier) via extractPdfText. Sans
      // cela, une facture reelle avec un sujet generique ("Voici vos
      // documents") et le mot "facture" uniquement a l'interieur du PDF
      // tombait a tort en ambigu (signale par l'utilisateur en production).
      interface PieceAClasser {
        piece: PieceJointeExtraite;
        type: TypeDocument;
        donnees: Buffer;
        hashFichier: string;
        numero: string | null;
      }
      const piecesAtraiter: PieceAClasser[] = [];

      for (const piece of piecesBrutes) {
        try {
          const attachment = await gmail.users.messages.attachments.get({
            userId: "me",
            messageId: ref.id,
            id: piece.attachmentId,
          });
          const donnees = Buffer.from(attachment.data.data || "", "base64url");
          const hashFichier = sha256Hex(donnees);

          // La deduplication (par empreinte de fichier) doit s'appliquer
          // AVANT toute chose, ambigu compris : sans cela, le meme e-mail
          // non reconnu (image de newsletter, logo...) etait re-signale
          // comme une toute nouvelle anomalie a chaque passage du
          // planificateur (toutes les 5 minutes), y compris apres avoir ete
          // "ignore" par l'utilisateur, qui le voyait donc revenir sans
          // cesse (bug reel signale par l'utilisateur en production).
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

          let contenuExtrait: string | undefined;
          if (piece.mimeType.toLowerCase() === "application/pdf") {
            try {
              contenuExtrait = extractPdfText(donnees);
            } catch {
              // pdftotext manquant ou PDF illisible : ne bloque pas la
              // classification, qui se rabat simplement sur le
              // sujet/corps/nom de fichier comme avant cette amelioration.
            }
          }

          const type = classifierPieceJointe(emailContexte, piece, contenuExtrait);
          const numero = extraireNumeroFacture(`${sujet} ${piece.nomFichier} ${contenuExtrait || ""}`);
          piecesAtraiter.push({ piece, type, donnees, hashFichier, numero });
        } catch (err) {
          resultat.erreurs.push(`${piece.nomFichier} : ${(err as Error).message}`);
        }
      }

      if (piecesAtraiter.length === 0) continue;

      const nbFactures = piecesAtraiter.filter((p) => p.type === "facture").length;
      const adresseDext = choisirAdresseDext(nbFactures);
      // Fiche fournisseur (section 6) resolue une seule fois par message,
      // et seulement si au moins un document est reellement reconnu
      // (facture, avoir, bon d'enlevement, releve, devis) : un lot
      // uniquement ambigu vient souvent d'un expediteur qui n'est pas un
      // vrai fournisseur (newsletter, notification...) — lui creer une
      // fiche aurait pollue la liste des fournisseurs (signale par
      // l'utilisateur en production).
      const auMoinsUnDocumentReconnu = piecesAtraiter.some((p) => p.type !== "ambigu");
      const fournisseurId = auMoinsUnDocumentReconnu ? await resoudreFournisseur(prisma, expediteur, cacheFournisseurs) : null;

      for (const { piece, type, donnees, hashFichier, numero } of piecesAtraiter) {
        try {
          if (type === "ambigu") {
            // Enregistre aussi un DocumentFournisseur (type "ambigu") pour
            // que le hash ci-dessus serve de garde-fou a la prochaine
            // synchronisation, en plus de creer l'anomalie a valider.
            await prisma.documentFournisseur.create({
              data: {
                type: "ambigu",
                fournisseurId,
                fichierNom: piece.nomFichier,
                numero,
                hashFichier,
                statutDext: "a_valider",
                gmailMessageId: ref.id,
                gmailAttachmentId: piece.attachmentId,
                mimeType: piece.mimeType,
                gmailExpediteur: expediteur,
                gmailObjet: sujet,
                dateReceptionMail: dateReception,
              },
            });
            await prisma.anomalie.create({
              data: {
                type: "document_gmail_ambigu",
                gravite: "moyenne",
                preuves: JSON.stringify({
                  messageId: ref.id,
                  attachmentId: piece.attachmentId,
                  mimeType: piece.mimeType,
                  expediteur,
                  sujet,
                  fichier: piece.nomFichier,
                }),
                actionProposee: "Examiner la piece jointe et la classer manuellement (facture, avoir, bon, releve).",
              },
            });
            resultat.documentsAmbigus++;
            resultat.documentsTraites++;
            continue;
          }

          if (type === "facture" && transfertAutomatiqueActif()) {
            await envoyerVersDext(gmail, { destinataire: adresseDext, nomFichier: piece.nomFichier, mimeType: piece.mimeType, donnees, sujetOrigine: sujet });
            await prisma.documentFournisseur.create({
              data: {
                type: "facture",
                fournisseurId,
                fichierNom: piece.nomFichier,
                numero,
                hashFichier,
                statutDext: "envoye",
                gmailMessageId: ref.id,
                gmailAttachmentId: piece.attachmentId,
                mimeType: piece.mimeType,
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
          } else if (type === "facture") {
            // Transfert automatique en pause (DEXT_AUTO_FORWARD=false) :
            // on etiquette dans Gmail par mois de reception pour un envoi
            // manuel groupe en fin de mois, plutot que de transmettre.
            const nomLabel = nomEtiquetteFacturesDuMois(dateReception || new Date());
            const labelId = await obtenirOuCreerLabel(gmail, nomLabel, cacheLabels);
            await gmail.users.messages.modify({ userId: "me", id: ref.id, requestBody: { addLabelIds: [labelId] } });
            await prisma.documentFournisseur.create({
              data: {
                type: "facture",
                fournisseurId,
                fichierNom: piece.nomFichier,
                numero,
                hashFichier,
                statutDext: "a_valider",
                gmailMessageId: ref.id,
                gmailAttachmentId: piece.attachmentId,
                mimeType: piece.mimeType,
                gmailExpediteur: expediteur,
                gmailObjet: sujet,
                dateReceptionMail: dateReception,
              },
            });
            await logEvenement(prisma, {
              evenement: "gmail_document",
              action: `Facture recue de ${expediteur} : ${piece.nomFichier}`,
              resultat: `Transfert automatique en pause : etiquetee "${nomLabel}" dans Gmail pour envoi manuel en fin de mois.`,
            });
          } else {
            // avoir | bon_enlevement | releve | devis : jamais envoyes a
            // Dext, archives pour controle (sections 6.3, 6.4).
            await prisma.documentFournisseur.create({
              data: {
                type,
                fournisseurId,
                fichierNom: piece.nomFichier,
                numero,
                hashFichier,
                statutDext: "archive",
                gmailMessageId: ref.id,
                gmailAttachmentId: piece.attachmentId,
                mimeType: piece.mimeType,
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

            if (type === "releve") {
              await controlerReleveFournisseur(prisma, {
                fournisseurId,
                fournisseurNom: extraireIdentiteExpediteur(expediteur).nom,
                fichierNom: piece.nomFichier,
              });
            }
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

export class DocumentFournisseurEnvoiError extends Error {}

/**
 * Envoi manuel vers Dext d'une facture fournisseur deja recue et
 * classifiee, mais pas encore transferee (statutDext "a_valider" : soit le
 * transfert automatique est en pause via DEXT_AUTO_FORWARD=false et la
 * facture attend l'envoi groupe de fin de mois, soit elle a ete corrigee
 * manuellement en "facture" depuis le centre de validation des anomalies).
 * Toujours a la demande explicite de l'utilisateur (bouton "Envoyer a
 * Dext"), jamais declenche automatiquement.
 */
export async function envoyerDocumentFournisseurVersDext(prisma: PrismaClient, documentId: string): Promise<void> {
  const document = await prisma.documentFournisseur.findUnique({ where: { id: documentId } });
  if (!document) throw new DocumentFournisseurEnvoiError("Document introuvable.");
  if (document.type !== "facture") {
    throw new DocumentFournisseurEnvoiError(`Seules les factures peuvent etre envoyees a Dext (type actuel : ${document.type}).`);
  }
  if (document.statutDext === "envoye") {
    throw new DocumentFournisseurEnvoiError("Cette facture a deja ete envoyee a Dext.");
  }
  if (!document.gmailMessageId || !document.gmailAttachmentId) {
    throw new DocumentFournisseurEnvoiError("Piece jointe non disponible (document trop ancien, avant l'enregistrement de sa reference Gmail).");
  }

  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) throw new DocumentFournisseurEnvoiError("Gmail non connecte.");
  const { gmail } = connexionGmail;

  const attachment = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId: document.gmailMessageId,
    id: document.gmailAttachmentId,
  });
  const donnees = Buffer.from(attachment.data.data || "", "base64url");

  // Un envoi manuel porte toujours sur un document a la fois : l'adresse
  // "multiple" (choisirAdresseDext) ne s'applique qu'au moment ou plusieurs
  // factures arrivent groupees dans le meme e-mail, contexte deja passe ici.
  const destinataire = choisirAdresseDext(1);
  await envoyerVersDext(gmail, {
    destinataire,
    nomFichier: document.fichierNom || "facture",
    mimeType: document.mimeType || "application/octet-stream",
    donnees,
    sujetOrigine: document.gmailObjet || document.fichierNom || "Facture fournisseur",
  });

  await prisma.documentFournisseur.update({ where: { id: documentId }, data: { statutDext: "envoye" } });
  await logEvenement(prisma, {
    evenement: "gmail_document",
    action: `Facture recue de ${document.gmailExpediteur} : ${document.fichierNom}`,
    resultat: `Envoyee manuellement vers ${destinataire} depuis le centre de fournisseurs.`,
  });
}
