import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import { extraireFichiersDepuisZip, mimeTypeDepuisNom, FichierExtrait } from "../importers/zipBulk";
import { extractPdfText, texteSignificatif } from "../importers/bankStatementPdf";
import { rendrePremierePageEnImage } from "../importers/pdfRenderImage";
import { extraireMontantHTFacture, extraireMontantTTCFacture, completerMontantHTSansTva, completerMontantTTCManquant, estAutoliquidation } from "./gmailClassify";
import { extraireChampsFacturePdf, extraireChampsFactureImage, CATEGORIES_FACTURE } from "./archiveComptableIA";
import { logEvenement } from "./journalService";

/**
 * Module Comptabilite : archive de secours des factures. Nee independante
 * du circuit "Factures fournisseurs" (DocumentFournisseur, alimente par
 * Gmail/Dext) - demande initiale de l'utilisateur (novembre 2026) : apres
 * un changement de comptable, l'ancien a supprime toutes les factures sur
 * Dext avant le transfert, il ne restait qu'un export manuel (PDF/JPEG,
 * plusieurs centaines de fichiers) fait avant la suppression. Depuis,
 * demande explicite complementaire : desormais, CHAQUE facture envoyee a
 * Dext (automatiquement ou manuellement, voir archiverFactureEnvoyeeDext
 * ci-dessous et gmailSync.ts) y est aussi copiee automatiquement - pour ne
 * plus jamais dependre uniquement de Dext, exactement la raison d'etre de
 * ce module. Le depot manuel (ZIP/fichiers) reste independant du
 * fournisseur Prisma existant (voir plus bas), mais l'archive elle-meme
 * n'est plus etanche au circuit Gmail/Dext.
 */

const DOSSIER_ARCHIVES = path.join(process.cwd(), "uploads", "archives-comptables");

export interface ResultatImportArchive {
  total: number;
}

export interface FactureEnvoyeeDext {
  fichierNom: string;
  mimeType: string;
  donnees: Buffer;
  fournisseurNom: string | null;
  numero: string | null;
  dateFacture: Date | null;
  montantHT: number | null;
  montantTTC: number | null;
}

/**
 * Archive une copie d'une facture au moment ou elle part reellement vers
 * Dext (envoi automatique ou manuel - voir gmailSync.ts, les deux seuls
 * points d'appel reels de envoyerVersDext). Les champs sont deja connus,
 * resolus par le circuit Gmail/fournisseurs - aucune extraction IA/regex
 * n'est relancee ici, jamais une nouvelle estimation. N'est jamais
 * bloquante pour l'envoi lui-meme : l'appelant doit l'entourer d'un
 * try/catch (voir gmailSync.ts) pour qu'un echec d'archivage ne fasse
 * jamais echouer l'envoi reel a Dext, bien plus critique.
 */
export async function archiverFactureEnvoyeeDext(prisma: PrismaClient, facture: FactureEnvoyeeDext): Promise<void> {
  await fs.mkdir(DOSSIER_ARCHIVES, { recursive: true });
  const extension = path.extname(facture.fichierNom) || (facture.mimeType === "application/pdf" ? ".pdf" : ".jpg");
  const cheminFichier = path.join(DOSSIER_ARCHIVES, `${crypto.randomUUID()}${extension}`);
  await fs.writeFile(cheminFichier, facture.donnees);

  const complet = facture.montantHT != null && facture.montantTTC != null && !!facture.fournisseurNom;
  await prisma.archiveComptable.create({
    data: {
      fichierNom: facture.fichierNom,
      cheminFichier,
      mimeType: facture.mimeType,
      fournisseurNom: facture.fournisseurNom,
      numero: facture.numero,
      dateFacture: facture.dateFacture,
      montantHT: facture.montantHT,
      montantTTC: facture.montantTTC,
      statut: complet ? "complete" : "a_verifier",
      classifiePar: null,
      categorie: null,
    },
  });
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
  return demarrerImportFichiers(prisma, fichiers);
}

/**
 * Meme import que demarrerImportArchiveZip, mais a partir de fichiers
 * deja deposes individuellement (plusieurs a la fois, voir
 * archiveComptableRoutes.ts) plutot que d'un ZIP - demande explicite de
 * l'utilisateur apres un essai reel en video : sur Windows, selectionner
 * un .zip dans la boite de depot d'un navigateur ouvre parfois l'archive
 * comme un DOSSIER navigable (double-clic sur un "dossier compresse")
 * plutot que de le choisir comme fichier, ce que l'explorateur de fichiers
 * lui-meme ne permet pas de corriger depuis le site. Selectionner
 * directement les PDF/JPEG (ex. Ctrl+A dans le dossier extrait) evite
 * entierement ce piege, au prix d'une seule difference : le navigateur,
 * pas unzip, se charge de lire chaque fichier, donc aucune verification
 * de type n'est a refaire ici (voir archiveComptableRoutes.ts, qui filtre
 * deja par extension a la reception).
 */
export async function demarrerImportFichiers(prisma: PrismaClient, fichiers: FichierExtrait[]): Promise<ResultatImportArchive> {
  if (fichiers.length === 0) {
    throw new Error("Aucun fichier PDF/JPEG/PNG recu.");
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
    } catch (err) {
      // Un fichier illisible (PDF corrompu, image trop lourde...) ne doit
      // jamais interrompre l'import des centaines d'autres fichiers du
      // meme lot - compte comme erreur, le reste continue. Le message reel
      // est journalise (nom du fichier + erreur) : avant ce correctif, une
      // erreur ici (ex. ecriture disque ou connexion base de donnees
      // saturee lors de plusieurs gros imports lances en meme temps) restait
      // totalement invisible - impossible de savoir, apres coup, pourquoi
      // un depot de plusieurs centaines de fichiers en comptait certains en
      // echec (constate en production, novembre 2026).
      erreurs++;
      await logEvenement(prisma, {
        evenement: "archive_comptable_import_fichier_erreur",
        action: `Import du fichier "${fichier.nom}"`,
        resultat: (err as Error).message,
      }).catch(() => {
        // Le journal lui-meme est indisponible : rien de plus a tenter,
        // le compteur "erreurs" ci-dessus reste quand meme a jour.
      });
    }
  }

  await logEvenement(prisma, {
    evenement: "archive_comptable_import_termine",
    action: "Import de l'archive comptable",
    resultat: `${complets} fichier(s) complets, ${aVerifier} a verifier, ${erreurs} erreur(s), sur ${fichiers.length} au total.`,
  });
}

// L'utilisateur (Atelier Brochant) n'est jamais son propre fournisseur -
// meme principe que MOTIF_DONNEUR_ORDRE_CONNU dans gmailClassify.ts, mais
// applique ici a l'extraction du NOM du fournisseur plutot qu'a la
// classification du document. Bug reel constate en production (novembre
// 2026, signale par l'utilisateur) : sur une facture La Plateforme Du
// Batiment (ou Costa Immobilier), le texte extractible du PDF ne contient
// QUE le nom du destinataire ("ATELIER BROCHANT", imprime en gros dans le
// bloc adresse de facturation) - le nom du vrai fournisseur n'etant qu'un
// logo/image non capture par pdftotext, l'IA n'avait alors litteralement
// que ce nom a lire et le reportait a tort comme fournisseurNom, sur des
// dizaines de factures reelles.
const MOTIF_PROPRE_ENTREPRISE = /^(?:sas\s+)?atelier\s+brochant(?:\s+sas)?$/i;

function estProprEntreprise(nom: string | null): boolean {
  return !!nom && MOTIF_PROPRE_ENTREPRISE.test(nom.trim());
}

// Convention de nommage des fichiers deposes dans l'archive (export Dext ou
// renommage manuel de l'utilisateur) : "<Fournisseur> - AAAA-MM-JJ -
// <reference>.<extension>" - vu sur la quasi-totalite des fichiers reels
// (OVHcloud, EDF, La Plateforme Du Batiment...). Source de repli FIABLE
// uniquement pour corriger le cas d'erreur ci-dessus (jamais utilisee en
// priorite sur une lecture reelle du document, souvent plus precise - ex.
// "Amazon" dans le nom de fichier mais "DELTA ELECTRIC INTERNATIONAL", le
// vrai vendeur tiers, correctement lu dans le document).
const MOTIF_NOM_FICHIER_FOURNISSEUR = /^(.+?) - \d{4}-\d{2}-\d{2} - /;

function extraireFournisseurDepuisNomFichier(fichierNom: string): string | null {
  const trouve = MOTIF_NOM_FICHIER_FOURNISSEUR.exec(fichierNom);
  return trouve ? trouve[1].trim() : null;
}

/**
 * Ecarte un fournisseurNom qui s'avere etre la propre entreprise de
 * l'utilisateur (jamais un fournisseur valide) et le remplace par celui
 * devine depuis le nom de fichier si ce dernier suit la convention connue -
 * sinon laisse le champ vide (jamais une fausse certitude) plutot que de
 * conserver une valeur prouvee fausse.
 */
function resoudreFournisseurNom(candidat: string | null, fichierNom: string): string | null {
  if (candidat && !estProprEntreprise(candidat)) return candidat;
  return extraireFournisseurDepuisNomFichier(fichierNom);
}

export interface ChampsExtraitsArchive {
  montantHT: number | null;
  montantTTC: number | null;
  fournisseurNom: string | null;
  numero: string | null;
  dateFacture: Date | null;
  classifiePar: string | null;
  categorie: string | null;
}

/**
 * Coeur de l'extraction (regle + IA), partage entre l'import initial
 * (traiterUnFichier) et la re-extraction d'une archive deja importee mais
 * restee "a verifier" (reextraireArchivesComptablesIncompletes) - sans
 * cette derniere, une archive importee AVANT un correctif (ex. le filet
 * vision IA sur un scan sans texte, ou un nouveau libelle de montant
 * reconnu) ne beneficiait jamais de ce correctif sans re-deposer tout le
 * ZIP, constate en production (novembre 2026, facture EDF reelle restee
 * "HT non renseigne" malgre "Montant Hors TVA" clairement lisible, ajoute
 * comme libelle reconnu apres son import).
 */
async function extraireChampsDocument(prisma: PrismaClient, donnees: Buffer, mimeType: string): Promise<ChampsExtraitsArchive> {
  let montantHT: number | null = null;
  let montantTTC: number | null = null;
  let fournisseurNom: string | null = null;
  let numero: string | null = null;
  let dateFacture: Date | null = null;
  let classifiePar: string | null = null;
  let categorie: string | null = null;

  if (mimeType === "application/pdf") {
    let texte: string | undefined;
    try {
      // texteSignificatif : pdftotext emet toujours au moins un saut de
      // page ("\f"), jamais une chaine vraiment vide, meme sur un PDF sans
      // aucune couche de texte (scan/photo integree) - sans cette
      // normalisation, ce "\f" isole est "truthy" en JS et le fichier est
      // a tort traite comme ayant du texte, sans jamais declencher le
      // repli vision IA ci-dessous (bug reel trouve en production,
      // novembre 2026 : deux scans reels restaient indefiniment
      // "a verifier" sans la moindre erreur nulle part).
      texte = texteSignificatif(extractPdfText(donnees));
    } catch {
      // pdftotext manquant ou PDF illisible : repli ci-dessous sur le
      // rendu en image (texte reste undefined).
    }
    if (texte) {
      montantHT = extraireMontantHTFacture(texte);
      montantTTC = extraireMontantTTCFacture(texte);
      const champsIA = await extraireChampsFacturePdf(texte, prisma);
      if (champsIA) {
        classifiePar = "ia";
        fournisseurNom = champsIA.fournisseurNom ?? null;
        numero = champsIA.numero ?? null;
        categorie = champsIA.categorie ?? null;
        if (champsIA.dateFacture) dateFacture = new Date(champsIA.dateFacture);
        if (montantHT == null && champsIA.montantHT != null) montantHT = champsIA.montantHT;
        if (montantTTC == null && champsIA.montantTTC != null) montantTTC = champsIA.montantTTC;
      }
      montantHT = completerMontantHTSansTva(texte, montantHT, montantTTC);
      montantTTC = completerMontantTTCManquant(texte, montantHT, montantTTC);
      // Marquage deterministe "Auto liquidation" (demande explicite de
      // l'utilisateur) : prioritaire sur la categorie proposee par l'IA
      // (ex. "Sous-traitance"), car c'est une mention EXPLICITE et certaine
      // du document lui-meme, jamais une deduction.
      if (estAutoliquidation(texte)) categorie = "Auto liquidation";
    } else {
      // PDF sans AUCUN texte extractible (scan/photo integree sans couche
      // texte, cas reel d'un export Dext fait a partir de factures papier
      // numerisees) : seule la vision IA sur la page rendue en image peut
      // encore y lire quelque chose - demande explicite de l'utilisateur
      // ("coder correctement pour qu'il puisse lire tous les montants").
      const image = rendrePremierePageEnImage(donnees);
      if (image) {
        const champsIA = await extraireChampsFactureImage(image, "image/png", prisma);
        if (champsIA) {
          classifiePar = "ia";
          fournisseurNom = champsIA.fournisseurNom ?? null;
          numero = champsIA.numero ?? null;
          categorie = champsIA.categorie ?? null;
          if (champsIA.dateFacture) dateFacture = new Date(champsIA.dateFacture);
          montantHT = champsIA.montantHT ?? null;
          montantTTC = champsIA.montantTTC ?? null;
        }
      }
    }
  } else {
    const champsIA = await extraireChampsFactureImage(donnees, mimeType, prisma);
    if (champsIA) {
      classifiePar = "ia";
      fournisseurNom = champsIA.fournisseurNom ?? null;
      numero = champsIA.numero ?? null;
      categorie = champsIA.categorie ?? null;
      if (champsIA.dateFacture) dateFacture = new Date(champsIA.dateFacture);
      montantHT = champsIA.montantHT ?? null;
      montantTTC = champsIA.montantTTC ?? null;
    }
  }

  return { montantHT, montantTTC, fournisseurNom, numero, dateFacture, classifiePar, categorie };
}

/** Retourne true si le fichier a ete enregistre avec tous les champs principaux deja renseignes. */
async function traiterUnFichier(prisma: PrismaClient, fichier: FichierExtrait): Promise<boolean> {
  const mimeType = mimeTypeDepuisNom(fichier.nom);
  const extension = path.extname(fichier.nom) || (mimeType === "application/pdf" ? ".pdf" : ".jpg");
  const cheminFichier = path.join(DOSSIER_ARCHIVES, `${crypto.randomUUID()}${extension}`);
  await fs.writeFile(cheminFichier, fichier.donnees);

  const { montantHT, montantTTC, fournisseurNom: fournisseurNomBrut, numero, dateFacture, classifiePar, categorie } = await extraireChampsDocument(
    prisma,
    fichier.donnees,
    mimeType
  );
  const fournisseurNom = resoudreFournisseurNom(fournisseurNomBrut, fichier.nom);
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
      categorie,
    },
  });

  return complet;
}

export interface ResultatReextractionArchives {
  total: number;
}

/**
 * Relance l'extraction (regle + IA) sur les archives deja importees mais
 * restees "a verifier", OU sans categorie (champ ajoute apres coup : toutes
 * les archives importees avant son ajout n'en ont jamais recu, meme celles
 * deja "complete"), OU dont le fournisseurNom s'avere etre la propre
 * entreprise de l'utilisateur (voir estProprEntreprise/resoudreFournisseurNom
 * - signale en production, novembre 2026 : des archives deja "complete",
 * categorie deja renseignee, restaient malgre tout corrompues avec ce
 * mauvais fournisseur sans jamais etre reprises par ce troisieme critere) -
 * sans bloquer la reponse HTTP (voir demarrerImportFichiers, meme
 * principe) : utile apres un correctif de l'extraction (nouveau libelle
 * reconnu, filet vision, nouvelle categorie...) pour que les archives deja
 * presentes en beneficient sans avoir a tout re-deposer. Ne retouche jamais
 * un champ deja renseigne (ex. corrige a la main via modifierArchiveComptable)
 * - ne complete que ce qui manque encore, hormis cette correction ciblee
 * d'une valeur prouvee fausse.
 */
export async function demarrerReextractionArchivesIncompletes(prisma: PrismaClient): Promise<ResultatReextractionArchives> {
  const aTraiter = await prisma.archiveComptable.findMany({
    where: {
      OR: [{ statut: "a_verifier" }, { categorie: null }, { fournisseurNom: { contains: "brochant", mode: "insensitive" } }],
    },
  });
  if (aTraiter.length === 0) return { total: 0 };

  reextraireArchives(prisma, aTraiter).catch(async (err) => {
    await logEvenement(prisma, {
      evenement: "archive_comptable_reextraction_erreur",
      action: "Re-extraction des archives comptables a verifier",
      resultat: (err as Error).message,
    });
  });

  return { total: aTraiter.length };
}

async function reextraireArchives(prisma: PrismaClient, archives: Awaited<ReturnType<typeof prisma.archiveComptable.findMany>>): Promise<void> {
  let completees = 0;
  let toujoursAVerifier = 0;
  let erreurs = 0;

  for (const archive of archives) {
    try {
      const donnees = await fs.readFile(archive.cheminFichier);
      const extrait = await extraireChampsDocument(prisma, donnees, archive.mimeType);
      const fournisseurNom = resoudreFournisseurNom(archive.fournisseurNom ?? extrait.fournisseurNom, archive.fichierNom);
      const numero = archive.numero ?? extrait.numero;
      const dateFacture = archive.dateFacture ?? extrait.dateFacture;
      const montantHT = archive.montantHT ?? extrait.montantHT;
      const montantTTC = archive.montantTTC ?? extrait.montantTTC;
      const classifiePar = archive.classifiePar ?? extrait.classifiePar;
      const categorie = archive.categorie ?? extrait.categorie;
      const complet = montantHT != null && montantTTC != null && !!fournisseurNom;
      await prisma.archiveComptable.update({
        where: { id: archive.id },
        data: { fournisseurNom, numero, dateFacture, montantHT, montantTTC, classifiePar, categorie, statut: complet ? "complete" : "a_verifier" },
      });
      if (complet) completees++;
      else toujoursAVerifier++;
    } catch (err) {
      // Fichier disparu du disque ou illisible : ne bloque jamais les
      // autres archives du meme lot (meme discipline que l'import initial).
      // Message reel journalise, meme principe que traiterFichiersArchive.
      erreurs++;
      await logEvenement(prisma, {
        evenement: "archive_comptable_reextraction_archive_erreur",
        action: `Re-extraction de l'archive "${archive.fichierNom}"`,
        resultat: (err as Error).message,
      }).catch(() => {
        // Le journal lui-meme est indisponible : rien de plus a tenter.
      });
    }
  }

  await logEvenement(prisma, {
    evenement: "archive_comptable_reextraction_terminee",
    action: "Re-extraction des archives comptables a verifier",
    resultat: `${completees} desormais complete(s), ${toujoursAVerifier} toujours a verifier, ${erreurs} erreur(s), sur ${archives.length} au total.`,
  });
}

export interface FiltresArchiveComptable {
  dateDebut?: Date;
  dateFin?: Date;
  fournisseurNom?: string;
  montantMin?: number;
  montantMax?: number;
  categorie?: string;
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
  if (filtres.categorie) {
    where.categorie = filtres.categorie;
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
  categorie?: string | null;
}

/** Correction manuelle (toujours prioritaire sur l'extraction automatique). */
export async function modifierArchiveComptable(prisma: PrismaClient, id: string, champs: ChampsModifiablesArchive) {
  const actuelle = await obtenirArchiveComptable(prisma, id);

  const fournisseurNom = champs.fournisseurNom !== undefined ? champs.fournisseurNom : actuelle.fournisseurNom;
  const numero = champs.numero !== undefined ? champs.numero : actuelle.numero;
  const dateFacture = champs.dateFacture !== undefined ? (champs.dateFacture ? new Date(champs.dateFacture) : null) : actuelle.dateFacture;
  const montantHT = champs.montantHT !== undefined ? champs.montantHT : actuelle.montantHT;
  const montantTTC = champs.montantTTC !== undefined ? champs.montantTTC : actuelle.montantTTC;
  if (champs.categorie !== undefined && champs.categorie !== null && !(CATEGORIES_FACTURE as readonly string[]).includes(champs.categorie)) {
    throw new Error(`Categorie invalide, attendu l'une de : ${CATEGORIES_FACTURE.join(", ")}`);
  }
  const categorie = champs.categorie !== undefined ? champs.categorie : actuelle.categorie;

  const complet = montantHT != null && montantTTC != null && !!fournisseurNom;

  return prisma.archiveComptable.update({
    where: { id },
    data: { fournisseurNom, numero, dateFacture, montantHT, montantTTC, categorie, statut: complet ? "complete" : "a_verifier" },
  });
}

export async function supprimerArchiveComptable(prisma: PrismaClient, id: string) {
  const archive = await obtenirArchiveComptable(prisma, id);
  await prisma.archiveComptable.delete({ where: { id } });
  await fs.unlink(archive.cheminFichier).catch(() => {
    // Fichier deja absent du disque : la suppression en base reste valide.
  });
}
