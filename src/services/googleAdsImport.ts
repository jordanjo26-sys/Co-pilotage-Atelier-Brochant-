import { PrismaClient } from "@prisma/client";
import { parserCampagnesAds, EnteteGoogleAdsIntrouvable } from "../importers/googleAdsCampagnes";
import { sha256Hex } from "./hash";
import { logEvenement } from "./journalService";
import { CampagneAds } from "./googleAds";

/**
 * Import manuel des campagnes Google Ads (palliatif le temps que l'acces
 * API soit valide par Google - voir src/services/googleAds.ts et la
 * conversation avec l'utilisateur). Chaque depot remplace la photographie
 * precedente : contrairement aux factures, il n'y a pas de notion de ligne
 * "nouvelle" vs "doublon" a l'interieur d'un rapport de campagnes, Morgane
 * lit toujours le dernier lot importe avec succes.
 */

export interface ResultatImportCampagnesAds {
  nbCampagnes: number;
  importBatchId: string;
}

export async function importerCampagnesAds(prisma: PrismaClient, fichierNom: string, buffer: Buffer): Promise<ResultatImportCampagnesAds> {
  const hashFichier = sha256Hex(buffer);

  const dejaImporte = await prisma.importBatch.findUnique({ where: { hashFichier } });
  if (dejaImporte) {
    throw new Error(`Ce fichier a deja ete importe le ${dejaImporte.dateImport.toLocaleString("fr-FR")}.`);
  }

  let lignes;
  try {
    lignes = parserCampagnesAds(buffer);
  } catch (err) {
    await logEvenement(prisma, {
      evenement: "import_campagnes_ads_erreur",
      action: `Depot de ${fichierNom}`,
      resultat: (err as Error).message,
    });
    if (err instanceof EnteteGoogleAdsIntrouvable) throw err;
    throw new Error(`Fichier illisible : ${(err as Error).message}`);
  }

  if (lignes.length === 0) {
    throw new Error("Aucune campagne trouvee dans ce fichier (en-tete reconnu mais aucune ligne de donnees).");
  }

  const batch = await prisma.importBatch.create({
    data: { fichierNom, typeDetecte: "google_ads_campagnes", hashFichier, nbLignes: lignes.length, nbNouveaux: lignes.length, statut: "ok" },
  });

  await prisma.campagneAdsImport.createMany({
    data: lignes.map((ligne) => ({ ...ligne, sourceImportId: batch.id })),
  });

  await logEvenement(prisma, {
    evenement: "import_campagnes_ads",
    action: `Depot de ${fichierNom} (campagnes Google Ads)`,
    resultat: `${lignes.length} campagne(s) importee(s).`,
  });

  return { nbCampagnes: lignes.length, importBatchId: batch.id };
}

export interface CampagnesAdsImporteesResultat {
  campagnes: CampagneAds[];
  importeLe: Date;
  fichierNom: string;
}

/**
 * Dernier lot importe avec succes, ou null si aucun import n'a jamais ete
 * fait. Retourne le meme format que l'API live (CampagneAds) pour que
 * Morgane puisse traiter les deux sources de maniere identique.
 */
export async function dernieresCampagnesImportees(prisma: PrismaClient): Promise<CampagnesAdsImporteesResultat | null> {
  const dernierLot = await prisma.importBatch.findFirst({
    where: { typeDetecte: "google_ads_campagnes", statut: "ok" },
    orderBy: { dateImport: "desc" },
  });
  if (!dernierLot) return null;

  const lignes = await prisma.campagneAdsImport.findMany({
    where: { sourceImportId: dernierLot.id },
    orderBy: { cout: "desc" },
  });

  return {
    fichierNom: dernierLot.fichierNom,
    importeLe: dernierLot.dateImport,
    campagnes: lignes.map((l) => ({
      id: l.id,
      nom: l.nom,
      statut: l.statut || "",
      type: l.type || "",
      budgetQuotidien: l.budgetQuotidien,
      impressions: l.impressions || 0,
      clics: l.clics || 0,
      cout: l.cout || 0,
      conversions: l.conversions || 0,
      ctr: l.ctr || 0,
      cpcMoyen: l.cpcMoyen || 0,
    })),
  };
}
