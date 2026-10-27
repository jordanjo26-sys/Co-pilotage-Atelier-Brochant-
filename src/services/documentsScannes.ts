import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import { PrismaClient } from "@prisma/client";
import { TypeDocument } from "./gmailClassify";
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

export async function enregistrerDocumentScanne(prisma: PrismaClient, params: ParametresDocumentScanne) {
  if (!typeDocumentScanneValide(params.type)) {
    throw new DocumentScanneError(`Type de document invalide, attendu l'un de : ${TYPES_AUTORISES.join(", ")}.`);
  }
  const fournisseurNom = params.fournisseurNom.trim();
  if (!fournisseurNom) {
    throw new DocumentScanneError("Le nom du fournisseur est obligatoire.");
  }

  const pdf = await construirePdfDepuisImage(params.image);
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
  const document = await prisma.documentFournisseur.create({
    data: {
      type: params.type,
      fournisseurId: fournisseur.id,
      fichierNom: `Scan ${maintenant.toLocaleDateString("fr-FR")} - ${fournisseurNom}.pdf`,
      numero: params.numero?.trim() || null,
      hashFichier,
      statutDext: params.type === "facture" ? "a_valider" : "archive",
      mimeType: "application/pdf",
      dateReceptionMail: maintenant,
      cheminFichier,
    },
  });

  await logEvenement(prisma, {
    evenement: "document_scanne",
    action: `Document papier numerise : ${fournisseurNom}`,
    resultat: `Type "${params.type}" enregistre${params.type === "facture" ? ", en attente d'envoi a Dext" : ", archive pour controle"}.`,
  });

  return document;
}
