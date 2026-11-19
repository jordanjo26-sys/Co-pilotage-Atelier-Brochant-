import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import { extraireFichiersDepuisZip, mimeTypeDepuisNom, FichierExtrait } from "../importers/zipBulk";
import { extractPdfText } from "../importers/bankStatementPdf";
import { rendrePremierePageEnImage } from "../importers/pdfRenderImage";
import { extraireMontantHTFacture, extraireMontantTTCFacture, completerMontantHTSansTva } from "./gmailClassify";
import { extraireChampsFacturePdf, extraireChampsFactureImage } from "./archiveComptableIA";
import { logEvenement } from "./journalService";

/**
 * Module Comptabilite : archive de secours des factures, independante du
 * circuit "Factures fournisseurs" (DocumentFournisseur, alimente par
 * Gmail/Dext). Demande explicite de l'utilisateur (novembre 2026) : apres
 * un changement de comptable, l'ancien a supprime toutes les factures sur
 * Dext avant le transfert - il ne restait qu'un export manuel (PDF/JPEG,
 * plusieurs centaines de fichiers) fait avant la suppression. Objectif :
 * pouvoir justifier ses factures en cas de controle fiscal, avec une
 * recherche par fournisseur/date/montant - jamais reliee a Dext ni a un
 * fournisseur Prisma existant.
 */

const DOSSIER_ARCHIVES = path.join(process.cwd(), "uploads", "archives-comptables");

export interface ResultatImportArchive {
  total: number;
}

/**
 * Demarre l'import d'une archive ZIP en arriere-plan (ne bloque jamais la
 * reponse HTTP : plusieurs centaines de fichiers, chacun avec un appel IA
 * eventuel, prendrait largement plus longtemps qu'une requete HTTP
 * normale). L'extraction de la liste des fichiers (synchrone, rapide) leve
 * une erreur immediate si l'archive est illisible ; le traitement fichier
 * par fichier se poursuit ensuite seul, visible au fur et a mesure dans
 * listerArchivesComptables.
 */
export async function demarrerImportArchiveZip(prisma: PrismaClient, buffer: Buffer): Promise<ResultatImportArchive> {
  const fichiers = extraireFichiersDepuisZip(buffer);
  if (fichiers.length === 0) {
    throw new Error("Aucun fichier PDF/JPEG/PNG trouve dans cette archive.");
  }

  await fs.mkdir(DOSSIER_ARCHIVES, { recursive: true });
  await logEvenement(prisma, {
    evenement: "archive_comptable_import_demarre",
    action: "Import de l'archive comptable",
    resultat: `${fichiers.length} fichier(s) a traiter.`,
  });

  traiterFichiersArchive(prisma, fichiers).catch(async (err) => {
    await logEvenement(prisma, {
      evenement: "archive_comptable_import_erreur",
      action: "Import de l'archive comptable",
      resultat: (err as Error).message,
    });
  });

  return { total: fichiers.length };
}

async function traiterFichiersArchive(prisma: PrismaClient, fichiers: FichierExtrait[]): Promise<void> {
  let complets = 0;
  let aVerifier = 0;
  let erreurs = 0;

  for (const fichier of fichiers) {
    try {
      const complet = await traiterUnFichier(prisma, fichier);
      if (complet) complets++;
      else aVerifier++;
    } catch {
      // Un fichier illisible (PDF corrompu, image trop lourde...) ne doit
      // jamais interrompre l'import des centaines d'autres fichiers du
      // meme lot - compte comme erreur, le reste continue.
      erreurs++;
    }
  }

  await logEvenement(prisma, {
    evenement: "archive_comptable_import_termine",
    action: "Import de l'archive comptable",
    resultat: `${complets} fichier(s) complets, ${aVerifier} a verifier, ${erreurs} erreur(s), sur ${fichiers.length} au total.`,
  });
}

/** Retourne true si le fichier a ete enregistre avec tous les champs principaux deja renseignes. */
async function traiterUnFichier(prisma: PrismaClient, fichier: FichierExtrait): Promise<boolean> {
  const mimeType = mimeTypeDepuisNom(fichier.nom);
  const extension = path.extname(fichier.nom) || (mimeType === "application/pdf" ? ".pdf" : ".jpg");
  const cheminFichier = path.join(DOSSIER_ARCHIVES, `${crypto.randomUUID()}${extension}`);
  await fs.writeFile(cheminFichier, fichier.donnees);

  let montantHT: number | null = null;
  let montantTTC: number | null = null;
  let fournisseurNom: string | null = null;
  let numero: string | null = null;
  let dateFacture: Date | null = null;
  let classifiePar: string | null = null;

  if (mimeType === "application/pdf") {
    let texte = "";
    try {
      texte = extractPdfText(fichier.donnees);
    } catch {
      // pdftotext manquant ou PDF illisible : repli ci-dessous sur le
      // rendu en image (texte reste vide).
    }
    if (texte) {
      montantHT = extraireMontantHTFacture(texte);
      montantTTC = extraireMontantTTCFacture(texte);
      const champsIA = await extraireChampsFacturePdf(texte);
      if (champsIA) {
        classifiePar = "ia";
        fournisseurNom = champsIA.fournisseurNom ?? null;
        numero = champsIA.numero ?? null;
        if (champsIA.dateFacture) dateFacture = new Date(champsIA.dateFacture);
        if (montantHT == null && champsIA.montantHT != null) montantHT = champsIA.montantHT;
        if (montantTTC == null && champsIA.montantTTC != null) montantTTC = champsIA.montantTTC;
      }
      montantHT = completerMontantHTSansTva(texte, montantHT, montantTTC);
    } else {
      // PDF sans AUCUN texte extractible (scan/photo integree sans couche
      // texte, cas reel d'un export Dext fait a partir de factures papier
      // numerisees) : seule la vision IA sur la page rendue en image peut
      // encore y lire quelque chose - demande explicite de l'utilisateur
      // ("coder correctement pour qu'il puisse lire tous les montants").
      const image = rendrePremierePageEnImage(fichier.donnees);
      if (image) {
        const champsIA = await extraireChampsFactureImage(image, "image/png");
        if (champsIA) {
          classifiePar = "ia";
          fournisseurNom = champsIA.fournisseurNom ?? null;
          numero = champsIA.numero ?? null;
          if (champsIA.dateFacture) dateFacture = new Date(champsIA.dateFacture);
          montantHT = champsIA.montantHT ?? null;
          montantTTC = champsIA.montantTTC ?? null;
        }
      }
    }
  } else {
    const champsIA = await extraireChampsFactureImage(fichier.donnees, mimeType);
    if (champsIA) {
      classifiePar = "ia";
      fournisseurNom = champsIA.fournisseurNom ?? null;
      numero = champsIA.numero ?? null;
      if (champsIA.dateFacture) dateFacture = new Date(champsIA.dateFacture);
      montantHT = champsIA.montantHT ?? null;
      montantTTC = champsIA.montantTTC ?? null;
    }
  }

  const complet = montantHT != null && montantTTC != null && !!fournisseurNom;

  await prisma.archiveComptable.create({
    data: {
      fichierNom: path.basename(fichier.nom),
      cheminFichier,
      mimeType,
      fournisseurNom,
      numero,
      dateFacture,
      montantHT,
      montantTTC,
      statut: complet ? "complete" : "a_verifier",
      classifiePar,
    },
  });

  return complet;
}

export interface FiltresArchiveComptable {
  dateDebut?: Date;
  dateFin?: Date;
  fournisseurNom?: string;
  montantMin?: number;
  montantMax?: number;
}

export async function listerArchivesComptables(prisma: PrismaClient, filtres: FiltresArchiveComptable = {}) {
  const where: Prisma.ArchiveComptableWhereInput = {};

  if (filtres.dateDebut || filtres.dateFin) {
    where.dateFacture = {
      ...(filtres.dateDebut ? { gte: filtres.dateDebut } : {}),
      ...(filtres.dateFin ? { lte: filtres.dateFin } : {}),
    };
  }
  if (filtres.fournisseurNom) {
    where.fournisseurNom = { contains: filtres.fournisseurNom, mode: "insensitive" };
  }
  if (filtres.montantMin != null || filtres.montantMax != null) {
    const conditionMontant = {
      ...(filtres.montantMin != null ? { gte: filtres.montantMin } : {}),
      ...(filtres.montantMax != null ? { lte: filtres.montantMax } : {}),
    };
    // Un montant filtre peut correspondre au HT OU au TTC affiche - l'utilisateur
    // ne sait pas forcement lequel il cherche (section demandee : "chercher
    // une facture via ... un montant").
    where.OR = [{ montantHT: conditionMontant }, { montantTTC: conditionMontant }];
  }

  return prisma.archiveComptable.findMany({
    where,
    orderBy: [{ dateFacture: "desc" }, { createdAt: "desc" }],
  });
}

export async function obtenirArchiveComptable(prisma: PrismaClient, id: string) {
  const archive = await prisma.archiveComptable.findUnique({ where: { id } });
  if (!archive) throw new Error("Archive introuvable.");
  return archive;
}

export interface ChampsModifiablesArchive {
  fournisseurNom?: string | null;
  numero?: string | null;
  dateFacture?: string | null; // AAAA-MM-JJ
  montantHT?: number | null;
  montantTTC?: number | null;
}

/** Correction manuelle (toujours prioritaire sur l'extraction automatique). */
export async function modifierArchiveComptable(prisma: PrismaClient, id: string, champs: ChampsModifiablesArchive) {
  const actuelle = await obtenirArchiveComptable(prisma, id);

  const fournisseurNom = champs.fournisseurNom !== undefined ? champs.fournisseurNom : actuelle.fournisseurNom;
  const numero = champs.numero !== undefined ? champs.numero : actuelle.numero;
  const dateFacture = champs.dateFacture !== undefined ? (champs.dateFacture ? new Date(champs.dateFacture) : null) : actuelle.dateFacture;
  const montantHT = champs.montantHT !== undefined ? champs.montantHT : actuelle.montantHT;
  const montantTTC = champs.montantTTC !== undefined ? champs.montantTTC : actuelle.montantTTC;

  const complet = montantHT != null && montantTTC != null && !!fournisseurNom;

  return prisma.archiveComptable.update({
    where: { id },
    data: { fournisseurNom, numero, dateFacture, montantHT, montantTTC, statut: complet ? "complete" : "a_verifier" },
  });
}

export async function supprimerArchiveComptable(prisma: PrismaClient, id: string) {
  const archive = await obtenirArchiveComptable(prisma, id);
  await prisma.archiveComptable.delete({ where: { id } });
  await fs.unlink(archive.cheminFichier).catch(() => {
    // Fichier deja absent du disque : la suppression en base reste valide.
  });
}
