import { DemandeIntervention, PrismaClient } from "@prisma/client";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

// Meme fuseau que agenda.ts (rendez-vous du standard telephonique) : le
// champ <input type="datetime-local"> du formulaire envoie une heure
// "naive" (ex. "2026-10-25T14:30", sans fuseau) qui doit etre lue comme une
// heure de Paris, pas celle du serveur (souvent UTC en production) - sinon
// une date saisie a 14h30 se retrouverait stockee a 14h30 UTC = 16h30 heure
// de Paris, decalage silencieux repere nulle part ailleurs dans l'appli.
const FUSEAU = "Europe/Paris";

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
export const SOURCES_ACQUISITION_VALIDES = ["google", "pages_jaunes", "maps"] as const;
export const CATEGORIES_VALIDES = ["plomberie", "serrurerie", "electricite", "assainissement"] as const;
export const OCCUPATIONS_VALIDES = ["proprietaire", "locataire"] as const;

export class DemandeInterventionValidationError extends Error {}

export interface DonneesDemandeIntervention {
  nom?: unknown;
  telephone?: unknown;
  email?: unknown;
  adresse?: unknown;
  codePostal?: unknown;
  ville?: unknown;
  typeLogement?: unknown;
  occupation?: unknown;
  etage?: unknown;
  codeAcces?: unknown;
  motif?: unknown;
  urgence?: unknown;
  dateSouhaitee?: unknown;
  dateSouhaiteeFin?: unknown;
  sourceAcquisition?: unknown;
  categorie?: unknown;
}

// Trois cas distincts (important pour modifierDemandeIntervention, un
// Prisma `update` ou `undefined` = "ne pas toucher au champ" alors que
// `null` = "l'effacer") : cle absente du payload -> undefined (ignoree),
// cle presente mais vide -> null (efface explicitement le champ), cle
// presente et non vide -> la valeur. creerDemandeIntervention ne voit
// jamais le cas "vide" (le formulaire de creation n'envoie que les champs
// remplis), donc ce changement ne modifie pas son comportement existant.
function texte(valeur: unknown): string | null | undefined {
  if (valeur === undefined) return undefined;
  return typeof valeur === "string" && valeur.trim() ? valeur.trim() : null;
}

function date(valeur: unknown): Date | null | undefined {
  if (valeur === undefined) return undefined;
  if (typeof valeur === "string" && valeur.trim()) {
    const d = dayjs.tz(valeur, FUSEAU);
    if (d.isValid()) return d.toDate();
  }
  return null;
}

function validerEtPreparer(donnees: DonneesDemandeIntervention): {
  nom: string;
  telephone?: string | null;
  email?: string | null;
  adresse?: string | null;
  codePostal?: string | null;
  ville?: string | null;
  typeLogement?: string | null;
  occupation?: string | null;
  etage?: string | null;
  codeAcces?: string | null;
  motif?: string | null;
  urgence?: string | null;
  dateSouhaitee?: Date | null;
  dateSouhaiteeFin?: Date | null;
  sourceAcquisition?: string | null;
  categorie?: string | null;
} {
  const nom = texte(donnees.nom);
  if (!nom) throw new DemandeInterventionValidationError("Le nom du client est requis.");

  // "" traite comme "non fourni" pour cette validation (un select remis a
  // son option vide par defaut) : seule une valeur non vide et hors liste
  // est une vraie erreur de saisie.
  if (donnees.urgence && !(URGENCES_VALIDES as readonly unknown[]).includes(donnees.urgence)) {
    throw new DemandeInterventionValidationError(`urgence invalide, attendu l'un de : ${URGENCES_VALIDES.join(", ")}`);
  }
  if (donnees.typeLogement && !(TYPES_LOGEMENT_VALIDES as readonly unknown[]).includes(donnees.typeLogement)) {
    throw new DemandeInterventionValidationError(`typeLogement invalide, attendu l'un de : ${TYPES_LOGEMENT_VALIDES.join(", ")}`);
  }
  if (donnees.sourceAcquisition && !(SOURCES_ACQUISITION_VALIDES as readonly unknown[]).includes(donnees.sourceAcquisition)) {
    throw new DemandeInterventionValidationError(`sourceAcquisition invalide, attendu l'un de : ${SOURCES_ACQUISITION_VALIDES.join(", ")}`);
  }
  if (donnees.categorie && !(CATEGORIES_VALIDES as readonly unknown[]).includes(donnees.categorie)) {
    throw new DemandeInterventionValidationError(`categorie invalide, attendu l'un de : ${CATEGORIES_VALIDES.join(", ")}`);
  }
  if (donnees.occupation && !(OCCUPATIONS_VALIDES as readonly unknown[]).includes(donnees.occupation)) {
    throw new DemandeInterventionValidationError(`occupation invalide, attendu l'un de : ${OCCUPATIONS_VALIDES.join(", ")}`);
  }

  // Coherence des dates : une fin avant le debut n'a pas de sens et viendrait
  // d'une erreur de saisie plutot que d'un cas reel (demande explicite :
  // "date de debut... date de fin... pour que celui-ci se mette directement
  // au planning", jamais d'inversion attendue).
  const dateSouhaitee = date(donnees.dateSouhaitee);
  const dateSouhaiteeFin = date(donnees.dateSouhaiteeFin);
  if (dateSouhaitee && dateSouhaiteeFin && dateSouhaiteeFin.getTime() < dateSouhaitee.getTime()) {
    throw new DemandeInterventionValidationError("La date de fin souhaitée ne peut pas être avant la date de début.");
  }

  return {
    nom,
    telephone: texte(donnees.telephone),
    email: texte(donnees.email),
    adresse: texte(donnees.adresse),
    codePostal: texte(donnees.codePostal),
    ville: texte(donnees.ville),
    typeLogement: texte(donnees.typeLogement),
    occupation: texte(donnees.occupation),
    etage: texte(donnees.etage),
    codeAcces: texte(donnees.codeAcces),
    motif: texte(donnees.motif),
    urgence: texte(donnees.urgence),
    dateSouhaitee,
    dateSouhaiteeFin,
    sourceAcquisition: texte(donnees.sourceAcquisition),
    categorie: texte(donnees.categorie),
  };
}

export async function creerDemandeIntervention(prisma: PrismaClient, donnees: DonneesDemandeIntervention): Promise<DemandeIntervention> {
  return prisma.demandeIntervention.create({ data: validerEtPreparer(donnees) });
}

/**
 * Permet de corriger une demande avant de l'envoyer vers Synec (demande
 * explicite : "un bouton modifier si j'ai une correction a faire") -
 * remplace l'ensemble des champs modifiables, le formulaire d'edition
 * cote interface envoyant toujours la fiche complete plutot qu'un
 * correctif partiel.
 */
export async function modifierDemandeIntervention(
  prisma: PrismaClient,
  id: string,
  donnees: DonneesDemandeIntervention
): Promise<DemandeIntervention> {
  return prisma.demandeIntervention.update({ where: { id }, data: validerEtPreparer(donnees) });
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
