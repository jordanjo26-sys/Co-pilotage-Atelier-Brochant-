import { DemandeIntervention, PrismaClient } from "@prisma/client";

/**
 * Demandes d'intervention prises par telephone (demande utilisateur :
 * remplacer la prise de note papier puis la double saisie dans Synec par
 * une fiche structuree depuis le telephone). Synec n'ayant pas d'API, ce
 * service ne fait QUE constituer une file d'attente "a saisir" - voir
 * src/services/synecSync.ts pour le parallele cote lecture (export
 * factures, lui aussi limite par l'absence d'API Synec).
 */

export const URGENCES_VALIDES = ["faible", "normale", "urgente"] as const;
export const TYPES_LOGEMENT_VALIDES = ["maison", "appartement"] as const;

export class DemandeInterventionValidationError extends Error {}

export interface DonneesDemandeIntervention {
  nom?: unknown;
  telephone?: unknown;
  email?: unknown;
  adresse?: unknown;
  codePostal?: unknown;
  ville?: unknown;
  typeLogement?: unknown;
  etage?: unknown;
  codeAcces?: unknown;
  motif?: unknown;
  urgence?: unknown;
}

function texte(valeur: unknown): string | undefined {
  return typeof valeur === "string" && valeur.trim() ? valeur.trim() : undefined;
}

export async function creerDemandeIntervention(prisma: PrismaClient, donnees: DonneesDemandeIntervention): Promise<DemandeIntervention> {
  const nom = texte(donnees.nom);
  if (!nom) throw new DemandeInterventionValidationError("Le nom du client est requis.");

  if (donnees.urgence !== undefined && !(URGENCES_VALIDES as readonly unknown[]).includes(donnees.urgence)) {
    throw new DemandeInterventionValidationError(`urgence invalide, attendu l'un de : ${URGENCES_VALIDES.join(", ")}`);
  }
  if (donnees.typeLogement !== undefined && !(TYPES_LOGEMENT_VALIDES as readonly unknown[]).includes(donnees.typeLogement)) {
    throw new DemandeInterventionValidationError(`typeLogement invalide, attendu l'un de : ${TYPES_LOGEMENT_VALIDES.join(", ")}`);
  }

  return prisma.demandeIntervention.create({
    data: {
      nom,
      telephone: texte(donnees.telephone),
      email: texte(donnees.email),
      adresse: texte(donnees.adresse),
      codePostal: texte(donnees.codePostal),
      ville: texte(donnees.ville),
      typeLogement: texte(donnees.typeLogement),
      etage: texte(donnees.etage),
      codeAcces: texte(donnees.codeAcces),
      motif: texte(donnees.motif),
      urgence: texte(donnees.urgence),
    },
  });
}

export async function listerDemandesIntervention(prisma: PrismaClient, statut: string): Promise<DemandeIntervention[]> {
  return prisma.demandeIntervention.findMany({
    where: statut === "toutes" ? undefined : { statut },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function marquerDemandeInterventionSaisie(prisma: PrismaClient, id: string): Promise<DemandeIntervention> {
  return prisma.demandeIntervention.update({
    where: { id },
    data: { statut: "saisie", saisieLe: new Date() },
  });
}
