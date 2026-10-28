import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import { PrismaClient } from "@prisma/client";
import { logEvenement } from "./journalService";

/**
 * Generation de documents PDF a la demande par Morgane ("fais-moi un
 * fichier" - demande explicite de l'utilisateur, volet "assistante
 * administrative"). Contenu structure en sections simples (titre,
 * paragraphes, puces) : suffisant pour un recapitulatif, un rapport ou une
 * lettre, sans demander a Morgane de maitriser une mise en page PDF
 * complexe - c'est a elle de repartir le texte qu'elle redige dans ces
 * blocs, pas a l'utilisateur de les lui dicter.
 *
 * Fichiers conserves localement (uploads/generes/, hors depot git comme
 * les autres uploads) et exposes via une route de telechargement dediee -
 * pas de ligne en base, un fichier perdu au redemarrage du serveur n'a
 * aucune consequence (document regenerable a la demande).
 */

const DOSSIER_GENERES = path.join(process.cwd(), "uploads", "generes");

export class DocumentGenereError extends Error {}

export interface SectionDocumentGenere {
  titre?: string;
  paragraphes?: string[];
  puces?: string[];
}

export interface ParametresDocumentGenere {
  titre: string;
  sections: SectionDocumentGenere[];
}

export interface ResultatDocumentGenere {
  nomFichier: string;
  url: string;
}

const NOM_FICHIER_VALIDE = /^[a-z0-9-]+\.pdf$/;

export function nomFichierGenereValide(nomFichier: string): boolean {
  return NOM_FICHIER_VALIDE.test(nomFichier);
}

export function cheminDocumentGenere(nomFichier: string): string {
  return path.join(DOSSIER_GENERES, nomFichier);
}

function construireNomFichier(titre: string): string {
  const slug = titre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "document"}-${crypto.randomUUID().slice(0, 8)}.pdf`;
}

function construirePdf(titre: string, sections: SectionDocumentGenere[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56 });
    const morceaux: Buffer[] = [];
    doc.on("data", (m) => morceaux.push(m));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(18).text(titre);
    doc.moveDown(0.2);
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#666666")
      .text(`Atelier Brochant - genere le ${new Date().toLocaleDateString("fr-FR")}`);
    doc.fillColor("#000000");
    doc.moveDown(1);

    for (const section of sections) {
      if (section.titre) {
        doc.font("Helvetica-Bold").fontSize(13).text(section.titre);
        doc.moveDown(0.3);
      }
      for (const paragraphe of section.paragraphes ?? []) {
        doc.font("Helvetica").fontSize(11).text(paragraphe, { align: "left", lineGap: 2 });
        doc.moveDown(0.4);
      }
      for (const puce of section.puces ?? []) {
        doc.font("Helvetica").fontSize(11).text(`•  ${puce}`, { indent: 10, lineGap: 2 });
        doc.moveDown(0.15);
      }
      doc.moveDown(0.6);
    }

    doc.end();
  });
}

export async function genererDocumentPdf(prisma: PrismaClient, params: ParametresDocumentGenere): Promise<ResultatDocumentGenere> {
  const titre = params.titre?.trim();
  if (!titre) {
    throw new DocumentGenereError("Le titre du document est obligatoire.");
  }
  if (!Array.isArray(params.sections) || params.sections.length === 0) {
    throw new DocumentGenereError("Le document doit contenir au moins une section (paragraphes ou puces).");
  }

  const pdf = await construirePdf(titre, params.sections);
  await fs.mkdir(DOSSIER_GENERES, { recursive: true });
  const nomFichier = construireNomFichier(titre);
  await fs.writeFile(cheminDocumentGenere(nomFichier), pdf);

  await logEvenement(prisma, {
    evenement: "document_genere",
    action: `Document PDF genere par Morgane : ${titre}`,
    resultat: `Fichier ${nomFichier}, ${params.sections.length} section(s).`,
  });

  return { nomFichier, url: `/api/documents-generes/${nomFichier}` };
}
