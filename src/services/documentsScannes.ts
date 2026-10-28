import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import { PrismaClient } from "@prisma/client";
import { TypeDocument, choisirAdresseDext } from "./gmailClassify";
import { transfertAutomatiqueActif, envoyerVersDext } from "./gmailSync";
import { getGmailClient } from "./googleAuth";
import { gmailEnPause, signalerLimiteGmail, reinitialiserLimiteGmail } from "./gmailRateLimit";
import { sha256Hex } from "./hash";
import { logEvenement } from "./journalService";

/**
 * Numerisation d'un document papier (facture, avoir, bon d'enlevement,
 * releve, devis) depuis l'appareil photo du telephone, demande explicite
 * de l'utilisateur ("je dois les scanner, mais ça sort mal"). A la
 * difference d'un document recu par Gmail (section 7), il n'existe ici
 * aucun message/piece jointe a redemander plus tard : la mise en page
 * nettoyee (recadree, contraste ameliore cote frontend, voir app.js) est
 * donc convertie en PDF et conservee localement (voir cheminFichier dans
 * DocumentFournisseur), hors du depot git comme les autres fichiers
 * televerses (.gitignore : uploads/).
 *
 * Rejoint ensuite exactement le meme circuit qu'un document recu par
 * e-mail : "Factures fournisseurs reçues" (facture, en attente d'envoi a
 * Dext) ou simplement archive pour controle (avoir/bon_enlevement/releve/
 * devis, jamais envoyes a Dext - meme regle que gmailSync.ts).
 */

const DOSSIER_SCANS = path.join(process.cwd(), "uploads", "scans");

const TYPES_AUTORISES: TypeDocument[] = ["facture", "avoir", "bon_enlevement", "releve", "devis"];

export function typeDocumentScanneValide(type: string): type is TypeDocument {
  return (TYPES_AUTORISES as string[]).includes(type);
}

/** Met en page l'image deja nettoyee (cote frontend) sur une page A4, centree. */
async function construirePdfDepuisImage(image: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 20 });
    const morceaux: Buffer[] = [];
    doc.on("data", (m) => morceaux.push(m));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);
    doc.image(image, doc.page.margins.left, doc.page.margins.top, {
      fit: [doc.page.width - doc.page.margins.left - doc.page.margins.right, doc.page.height - doc.page.margins.top - doc.page.margins.bottom],
      align: "center",
      valign: "center",
    });
    doc.end();
  });
}

export class DocumentScanneError extends Error {}

export interface ParametresDocumentScanne {
  image: Buffer;
  type: string;
  fournisseurNom: string;
  numero?: string | null;
}

interface ParametresCommuns {
  type: string;
  fournisseurNom: string;
  numero?: string | null;
}

/**
 * Finalise l'enregistrement d'un PDF deja pret (soit construit depuis une
 * image scannee, soit une piece jointe deja au format PDF - voir
 * enregistrerDocumentDepuisPieceJointe) : hash, ecriture disque, upsert du
 * fournisseur, envoi automatique vers Dext si c'est une facture, puis
 * creation de la ligne DocumentFournisseur. Extrait d'enregistrerDocumentScanne
 * pour etre partage avec les pieces jointes recues dans la conversation
 * Morgane, qui n'ont pas toujours besoin d'etre rasterisees (un PDF recu
 * tel quel ne doit pas etre reconverti en image puis re-rendu en PDF, ce
 * qui degraderait inutilement la qualite).
 */
async function finaliserDocument(prisma: PrismaClient, pdf: Buffer, params: ParametresCommuns, libellePrefixe: string) {
  if (!typeDocumentScanneValide(params.type)) {
    throw new DocumentScanneError(`Type de document invalide, attendu l'un de : ${TYPES_AUTORISES.join(", ")}.`);
  }
  const fournisseurNom = params.fournisseurNom.trim();
  if (!fournisseurNom) {
    throw new DocumentScanneError("Le nom du fournisseur est obligatoire.");
  }

  const hashFichier = sha256Hex(pdf);

  await fs.mkdir(DOSSIER_SCANS, { recursive: true });
  const cheminFichier = path.join(DOSSIER_SCANS, `${crypto.randomUUID()}.pdf`);
  await fs.writeFile(cheminFichier, pdf);

  const fournisseur = await prisma.fournisseur.upsert({
    where: { nom: fournisseurNom },
    update: {},
    create: { nom: fournisseurNom, modeReception: "papier" },
  });

  const maintenant = new Date();
  const fichierNom = `${libellePrefixe} ${maintenant.toLocaleDateString("fr-FR")} - ${fournisseurNom}.pdf`;

  // Une fois le document rattache a un fournisseur, une facture suit la
  // meme regle que par e-mail (gmailSync.ts, cas standard) : envoi
  // automatique vers Dext si actif (DEXT_AUTO_FORWARD), demande explicite
  // de l'utilisateur apres la mise en place du scanner. Jamais bloquant :
  // Gmail deconnecte, quota depasse ou toute autre panne laisse
  // simplement le document "a_valider" plutot que de faire echouer tout
  // l'enregistrement (le document photographie, lui, ne doit jamais etre
  // perdu).
  let statutDext: string = params.type === "facture" ? "a_valider" : "archive";
  let envoiAutoReussi = false;
  if (params.type === "facture" && transfertAutomatiqueActif() && !gmailEnPause()) {
    try {
      const connexionGmail = await getGmailClient(prisma);
      if (connexionGmail) {
        await envoyerVersDext(connexionGmail.gmail, {
          destinataire: choisirAdresseDext(1),
          nomFichier: fichierNom,
          mimeType: "application/pdf",
          donnees: pdf,
          sujetOrigine: `${libellePrefixe} - ${fournisseurNom}`,
        });
        reinitialiserLimiteGmail();
        statutDext = "envoye";
        envoiAutoReussi = true;
      }
    } catch (err) {
      const messageErreur = (err as Error).message;
      if (/User-rate limit exceeded|Quota exceeded/i.test(messageErreur)) signalerLimiteGmail(messageErreur);
      // Echec de l'envoi automatique : document conserve, a envoyer
      // manuellement depuis "Factures fournisseurs reçues" (statutDext
      // reste "a_valider", valeur par defaut ci-dessus).
    }
  }

  const document = await prisma.documentFournisseur.create({
    data: {
      type: params.type,
      fournisseurId: fournisseur.id,
      fichierNom,
      numero: params.numero?.trim() || null,
      hashFichier,
      statutDext,
      mimeType: "application/pdf",
      dateReceptionMail: maintenant,
      cheminFichier,
    },
  });

  await logEvenement(prisma, {
    evenement: "document_scanne",
    action: `${libellePrefixe} : ${fournisseurNom}`,
    resultat:
      params.type !== "facture"
        ? `Type "${params.type}" enregistre, archive pour controle.`
        : envoiAutoReussi
          ? "Facture envoyee automatiquement vers Dext."
          : "Facture enregistree, en attente d'envoi a Dext.",
  });

  return document;
}

export async function enregistrerDocumentScanne(prisma: PrismaClient, params: ParametresDocumentScanne) {
  const pdf = await construirePdfDepuisImage(params.image);
  return finaliserDocument(prisma, pdf, params, "Document papier numerise");
}

// jpeg/png seulement : ce sont les deux seuls formats que pdfkit sait
// mettre en page (doc.image()) - webp/heic echoueraient silencieusement a
// la conversion.
const MIME_IMAGES_AUTORISEES = ["image/jpeg", "image/png"];

export interface ParametresDocumentPieceJointe extends ParametresCommuns {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Enregistre un document recu en piece jointe dans la conversation Morgane
 * (section "assistante administrative" - photo ou fichier PDF envoye
 * directement dans le chat). Contrairement a enregistrerDocumentScanne
 * (toujours une image a mettre en page), une piece jointe deja au format
 * PDF est conservee telle quelle plutot que rasterisee puis re-rendue, ce
 * qui perdrait en qualite et en poids sans aucune raison.
 */
export async function enregistrerDocumentDepuisPieceJointe(prisma: PrismaClient, params: ParametresDocumentPieceJointe) {
  let pdf: Buffer;
  if (params.mimeType === "application/pdf") {
    pdf = params.buffer;
  } else if (MIME_IMAGES_AUTORISEES.includes(params.mimeType)) {
    pdf = await construirePdfDepuisImage(params.buffer);
  } else {
    throw new DocumentScanneError(
      `Type de fichier non pris en charge ("${params.mimeType}") : envoie une photo (jpeg/png/webp) ou un PDF.`
    );
  }
  return finaliserDocument(prisma, pdf, params, "Document recu par Morgane");
}
