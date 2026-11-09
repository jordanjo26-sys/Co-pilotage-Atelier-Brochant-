import { PrismaClient } from "@prisma/client";
import { logEvenement } from "./journalService";

/**
 * PagesJaunes/Solocal Manager, mode "assiste" : Solocal n'offre aucune API
 * et son SSO bloque explicitement les navigateurs automatises (Cloudflare),
 * donc contrairement au module Reseaux sociaux (Facebook/Instagram,
 * publication via API), il n'y a ici aucune etape "appliquer" automatique.
 * Morgane (ou l'utilisateur) redige une proposition - actualite/offre, mise
 * a jour d'un champ de la fiche, ou reponse a un avis -, elle est validee
 * sur l'ecran dedie, puis l'utilisateur la colle lui-meme dans Solocal
 * Manager et la marque "publiee" une fois fait.
 *
 * Un seul etablissement existe pour ce module (117 avenue du General
 * Leclerc, 77400 Lagny-sur-Marne) : valeur fixe, jamais redemandee.
 */

export const ETABLISSEMENT_PAGESJAUNES = "A.B Atelier Brochant - 117 avenue du Général Leclerc, 77400 Lagny-sur-Marne";

const CHAMPS_FICHE_VALIDES = ["description", "services", "horaires", "autre"];

export interface PropositionActualiteEntree {
  texte: string;
  cheminMedia?: string;
  justification: string;
}

export interface PropositionInfoFicheEntree {
  champFiche: string;
  texte: string;
  justification: string;
}

export interface PropositionReponseAvisEntree {
  avisTexte: string;
  texte: string; // reponse proposee
  avisClientNom?: string;
  avisNote?: number;
  justification: string;
}

export async function creerPropositionActualite(prisma: PrismaClient, entree: PropositionActualiteEntree) {
  if (!entree.texte) throw new Error("texte manquant.");
  const proposition = await prisma.propositionPagesJaunes.create({
    data: {
      type: "actualite",
      etablissement: ETABLISSEMENT_PAGESJAUNES,
      texte: entree.texte,
      cheminMedia: entree.cheminMedia ?? null,
      justification: entree.justification,
    },
  });
  await logEvenement(prisma, { evenement: "proposition_pagesjaunes_creee", action: "Nouvelle actualite PagesJaunes", resultat: entree.justification });
  return proposition;
}

export async function creerPropositionInfoFiche(prisma: PrismaClient, entree: PropositionInfoFicheEntree) {
  if (!CHAMPS_FICHE_VALIDES.includes(entree.champFiche)) {
    throw new Error(`champFiche invalide : attendu l'un de ${CHAMPS_FICHE_VALIDES.join(", ")}.`);
  }
  if (!entree.texte) throw new Error("texte manquant.");
  const proposition = await prisma.propositionPagesJaunes.create({
    data: {
      type: "info_fiche",
      etablissement: ETABLISSEMENT_PAGESJAUNES,
      texte: entree.texte,
      champFiche: entree.champFiche,
      justification: entree.justification,
    },
  });
  await logEvenement(prisma, { evenement: "proposition_pagesjaunes_creee", action: `Mise a jour fiche PagesJaunes (${entree.champFiche})`, resultat: entree.justification });
  return proposition;
}

export async function creerPropositionReponseAvis(prisma: PrismaClient, entree: PropositionReponseAvisEntree) {
  if (!entree.avisTexte) throw new Error("avisTexte manquant.");
  if (!entree.texte) throw new Error("texte (reponse proposee) manquant.");
  if (entree.avisNote !== undefined && (entree.avisNote < 1 || entree.avisNote > 5)) {
    throw new Error("avisNote doit etre comprise entre 1 et 5.");
  }
  const proposition = await prisma.propositionPagesJaunes.create({
    data: {
      type: "reponse_avis",
      etablissement: ETABLISSEMENT_PAGESJAUNES,
      texte: entree.texte,
      avisTexte: entree.avisTexte,
      avisClientNom: entree.avisClientNom ?? null,
      avisNote: entree.avisNote ?? null,
      justification: entree.justification,
    },
  });
  await logEvenement(prisma, { evenement: "proposition_pagesjaunes_creee", action: "Reponse a un avis PagesJaunes", resultat: entree.justification });
  return proposition;
}

export async function listerPropositionsPagesJaunes(prisma: PrismaClient, type?: string, statut?: string) {
  return prisma.propositionPagesJaunes.findMany({
    where: { ...(type ? { type } : {}), ...(statut ? { statut } : {}) },
    orderBy: { creeLe: "desc" },
  });
}

export async function accepterPropositionPagesJaunes(prisma: PrismaClient, id: string) {
  const proposition = await prisma.propositionPagesJaunes.findUnique({ where: { id } });
  if (!proposition) throw new Error("Proposition introuvable.");
  if (proposition.statut !== "en_attente") {
    throw new Error(`Cette proposition est au statut "${proposition.statut}", pas "en_attente".`);
  }
  return prisma.propositionPagesJaunes.update({ where: { id }, data: { statut: "acceptee", decideLe: new Date() } });
}

export async function refuserPropositionPagesJaunes(prisma: PrismaClient, id: string) {
  const proposition = await prisma.propositionPagesJaunes.findUnique({ where: { id } });
  if (!proposition) throw new Error("Proposition introuvable.");
  if (proposition.statut !== "en_attente") {
    throw new Error(`Cette proposition est au statut "${proposition.statut}", pas "en_attente".`);
  }
  return prisma.propositionPagesJaunes.update({ where: { id }, data: { statut: "refusee", decideLe: new Date() } });
}

export interface EtatActualitesPagesJaunes {
  nbPublieesCeMois: number;
  objectifMensuel: number;
  dernieresActualites: { texte: string; publieeLe: Date | null }[];
}

/**
 * Lecture seule, utilisee a la fois par Morgane (outil de contexte avant de
 * proposer) et par l'analyse hebdomadaire automatique (pagesJaunesRecap.ts) :
 * ou en est-on par rapport a l'objectif Solocal (4 actualites/mois), et
 * quels sont les derniers textes publies (pour ne pas repeter le meme angle).
 */
export async function obtenirEtatActualitesPagesJaunes(prisma: PrismaClient, maintenant: Date = new Date()): Promise<EtatActualitesPagesJaunes> {
  const debutMois = new Date(maintenant.getFullYear(), maintenant.getMonth(), 1);
  const nbPublieesCeMois = await prisma.propositionPagesJaunes.count({
    where: { type: "actualite", statut: "publiee", publieeLe: { gte: debutMois } },
  });
  const dernieresActualites = await prisma.propositionPagesJaunes.findMany({
    where: { type: "actualite", statut: "publiee" },
    orderBy: { publieeLe: "desc" },
    take: 5,
    select: { texte: true, publieeLe: true },
  });
  return { nbPublieesCeMois, objectifMensuel: 4, dernieresActualites };
}

/** Marquee par l'utilisateur une fois la proposition collee et publiee a la main dans Solocal Manager. */
export async function marquerPublieePropositionPagesJaunes(prisma: PrismaClient, id: string) {
  const proposition = await prisma.propositionPagesJaunes.findUnique({ where: { id } });
  if (!proposition) throw new Error("Proposition introuvable.");
  if (proposition.statut !== "acceptee") {
    throw new Error(`Cette proposition est au statut "${proposition.statut}", pas "acceptee" - accepte-la d'abord.`);
  }
  const miseAJour = await prisma.propositionPagesJaunes.update({ where: { id }, data: { statut: "publiee", publieeLe: new Date() } });
  await logEvenement(prisma, {
    evenement: "proposition_pagesjaunes_publiee",
    action: `Proposition PagesJaunes publiee (${proposition.type})`,
    resultat: "Confirmee comme publiee manuellement par l'utilisateur dans Solocal Manager.",
  });
  return miseAJour;
}
