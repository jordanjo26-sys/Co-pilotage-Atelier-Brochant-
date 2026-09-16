import { Prisma, PrismaClient } from "@prisma/client";

/**
 * Tarifier plomberie / electricite / serrurerie.
 *
 * Grille de prix indicatifs (main d'oeuvre + materiel) pour les prestations
 * courantes des trois metiers, consultable et modifiable depuis l'interface
 * pour etablir un devis rapidement.
 *
 * Important : les prix ne sont PAS recuperes automatiquement chez les
 * fournisseurs (Cedeo, La Plateforme du Batiment, Foussier, Richardson...).
 * Ce sont des enseignes professionnelles dont les tarifs sont masques sans
 * compte pro connecte, et dont les sites bloquent de toute facon l'acces
 * automatise (verifie : 403 sur cedeo.fr). Le seed initial (voir
 * scripts/seed-tarifs.ts) ne contient donc que des estimations de marche
 * (`source: "estimation_marche"`), a verifier et ajuster avec vos propres
 * comptes fournisseurs avant utilisation pour un devis client.
 */

export const METIERS_TARIF = ["plomberie", "electricite", "serrurerie"] as const;
export type MetierTarif = (typeof METIERS_TARIF)[number];

export interface TarifPrestationEntree {
  metier: string;
  categorie: string;
  designation: string;
  unite: string;
  prixMateriel?: number | null;
  prixMainOeuvre?: number | null;
  prixVenteHT: number;
  fournisseurRef?: string | null;
  source?: string | null;
  notes?: string | null;
  actif?: boolean;
}

export class TarifInvalideError extends Error {}
export class TarifDoublonError extends Error {}

function estDoublonPrisma(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function valider(entree: Partial<TarifPrestationEntree>, { partiel }: { partiel: boolean }): void {
  if (!partiel || entree.metier !== undefined) {
    if (typeof entree.metier !== "string" || !METIERS_TARIF.includes(entree.metier as MetierTarif)) {
      throw new TarifInvalideError(`metier invalide, attendu l'un de : ${METIERS_TARIF.join(", ")}`);
    }
  }
  if (!partiel || entree.categorie !== undefined) {
    if (typeof entree.categorie !== "string" || entree.categorie.trim() === "") {
      throw new TarifInvalideError("categorie requise.");
    }
  }
  if (!partiel || entree.designation !== undefined) {
    if (typeof entree.designation !== "string" || entree.designation.trim() === "") {
      throw new TarifInvalideError("designation requise.");
    }
  }
  if (!partiel || entree.unite !== undefined) {
    if (typeof entree.unite !== "string" || entree.unite.trim() === "") {
      throw new TarifInvalideError("unite requise.");
    }
  }
  if (!partiel || entree.prixVenteHT !== undefined) {
    if (typeof entree.prixVenteHT !== "number" || !Number.isFinite(entree.prixVenteHT) || entree.prixVenteHT < 0) {
      throw new TarifInvalideError("prixVenteHT requis, doit etre un nombre positif.");
    }
  }
  for (const champ of ["prixMateriel", "prixMainOeuvre"] as const) {
    const valeur = entree[champ];
    if (valeur !== undefined && valeur !== null && (typeof valeur !== "number" || !Number.isFinite(valeur) || valeur < 0)) {
      throw new TarifInvalideError(`${champ} doit etre un nombre positif ou vide.`);
    }
  }
}

export interface FiltreTarifs {
  metier?: string;
  categorie?: string;
  actifSeulement?: boolean;
}

export async function listerTarifs(prisma: PrismaClient, filtre: FiltreTarifs = {}) {
  return prisma.tarifPrestation.findMany({
    where: {
      ...(filtre.metier ? { metier: filtre.metier } : {}),
      ...(filtre.categorie ? { categorie: filtre.categorie } : {}),
      ...(filtre.actifSeulement ? { actif: true } : {}),
    },
    orderBy: [{ metier: "asc" }, { categorie: "asc" }, { designation: "asc" }],
  });
}

export async function creerTarif(prisma: PrismaClient, entree: TarifPrestationEntree) {
  valider(entree, { partiel: false });
  try {
    return await prisma.tarifPrestation.create({
      data: {
        metier: entree.metier,
        categorie: entree.categorie.trim(),
        designation: entree.designation.trim(),
        unite: entree.unite.trim(),
        prixMateriel: entree.prixMateriel ?? null,
        prixMainOeuvre: entree.prixMainOeuvre ?? null,
        prixVenteHT: entree.prixVenteHT,
        fournisseurRef: entree.fournisseurRef?.trim() || null,
        source: entree.source?.trim() || "estimation_marche",
        notes: entree.notes?.trim() || null,
        actif: entree.actif ?? true,
      },
    });
  } catch (err) {
    if (estDoublonPrisma(err)) {
      throw new TarifDoublonError(`Une ligne existe deja pour ce metier avec la designation "${entree.designation.trim()}".`);
    }
    throw err;
  }
}

export async function modifierTarif(prisma: PrismaClient, id: string, entree: Partial<TarifPrestationEntree>) {
  valider(entree, { partiel: true });
  const existant = await prisma.tarifPrestation.findUnique({ where: { id } });
  if (!existant) throw new Error("Tarif introuvable.");

  try {
    return await prisma.tarifPrestation.update({
      where: { id },
      data: {
        ...(entree.metier !== undefined ? { metier: entree.metier } : {}),
        ...(entree.categorie !== undefined ? { categorie: entree.categorie.trim() } : {}),
        ...(entree.designation !== undefined ? { designation: entree.designation.trim() } : {}),
        ...(entree.unite !== undefined ? { unite: entree.unite.trim() } : {}),
        ...(entree.prixMateriel !== undefined ? { prixMateriel: entree.prixMateriel } : {}),
        ...(entree.prixMainOeuvre !== undefined ? { prixMainOeuvre: entree.prixMainOeuvre } : {}),
        ...(entree.prixVenteHT !== undefined ? { prixVenteHT: entree.prixVenteHT } : {}),
        ...(entree.fournisseurRef !== undefined ? { fournisseurRef: entree.fournisseurRef?.trim() || null } : {}),
        ...(entree.source !== undefined ? { source: entree.source?.trim() || null } : {}),
        ...(entree.notes !== undefined ? { notes: entree.notes?.trim() || null } : {}),
        ...(entree.actif !== undefined ? { actif: entree.actif } : {}),
      },
    });
  } catch (err) {
    if (estDoublonPrisma(err)) {
      throw new TarifDoublonError(`Une ligne existe deja pour ce metier avec cette designation.`);
    }
    throw err;
  }
}

export async function supprimerTarif(prisma: PrismaClient, id: string): Promise<void> {
  try {
    await prisma.tarifPrestation.delete({ where: { id } });
  } catch {
    throw new Error("Tarif introuvable.");
  }
}
