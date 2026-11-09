import { PrismaClient } from "@prisma/client";
import { logEvenement } from "./journalService";

/**
 * Actualites PagesJaunes/Solocal Manager, mode "assiste" : Solocal n'offre
 * aucune API et son SSO bloque explicitement les navigateurs automatises
 * (Cloudflare), donc contrairement au module Reseaux sociaux (Facebook/
 * Instagram, publication via API), il n'y a ici aucune etape "appliquer"
 * automatique. Morgane (ou l'utilisateur) redige une proposition, elle est
 * validee sur l'ecran dedie, puis l'utilisateur la colle lui-meme dans
 * Solocal Manager et la marque "publiee" une fois fait.
 */

export interface PropositionActualitePagesJaunesEntree {
  etablissement: string;
  texte: string;
  cheminMedia?: string;
  justification: string;
}

export async function creerPropositionActualitePagesJaunes(prisma: PrismaClient, entree: PropositionActualitePagesJaunesEntree) {
  if (!entree.etablissement) throw new Error("etablissement manquant.");
  if (!entree.texte) throw new Error("texte manquant.");

  const proposition = await prisma.propositionActualitePagesJaunes.create({
    data: {
      etablissement: entree.etablissement,
      texte: entree.texte,
      cheminMedia: entree.cheminMedia ?? null,
      justification: entree.justification,
    },
  });

  await logEvenement(prisma, {
    evenement: "proposition_actualite_pagesjaunes_creee",
    action: `Nouvelle actualite PagesJaunes (${entree.etablissement})`,
    resultat: entree.justification,
  });

  return proposition;
}

export async function listerPropositionsActualitesPagesJaunes(prisma: PrismaClient, statut?: string) {
  return prisma.propositionActualitePagesJaunes.findMany({
    where: statut ? { statut } : undefined,
    orderBy: { creeLe: "desc" },
  });
}

export async function accepterPropositionActualitePagesJaunes(prisma: PrismaClient, id: string) {
  const proposition = await prisma.propositionActualitePagesJaunes.findUnique({ where: { id } });
  if (!proposition) throw new Error("Proposition introuvable.");
  if (proposition.statut !== "en_attente") {
    throw new Error(`Cette proposition est au statut "${proposition.statut}", pas "en_attente".`);
  }
  return prisma.propositionActualitePagesJaunes.update({ where: { id }, data: { statut: "acceptee", decideLe: new Date() } });
}

export async function refuserPropositionActualitePagesJaunes(prisma: PrismaClient, id: string) {
  const proposition = await prisma.propositionActualitePagesJaunes.findUnique({ where: { id } });
  if (!proposition) throw new Error("Proposition introuvable.");
  if (proposition.statut !== "en_attente") {
    throw new Error(`Cette proposition est au statut "${proposition.statut}", pas "en_attente".`);
  }
  return prisma.propositionActualitePagesJaunes.update({ where: { id }, data: { statut: "refusee", decideLe: new Date() } });
}

/** Marquee par l'utilisateur une fois l'actualite collee et publiee a la main dans Solocal Manager. */
export async function marquerPublieePropositionActualitePagesJaunes(prisma: PrismaClient, id: string) {
  const proposition = await prisma.propositionActualitePagesJaunes.findUnique({ where: { id } });
  if (!proposition) throw new Error("Proposition introuvable.");
  if (proposition.statut !== "acceptee") {
    throw new Error(`Cette proposition est au statut "${proposition.statut}", pas "acceptee" - accepte-la d'abord.`);
  }
  const miseAJour = await prisma.propositionActualitePagesJaunes.update({ where: { id }, data: { statut: "publiee", publieeLe: new Date() } });
  await logEvenement(prisma, {
    evenement: "proposition_actualite_pagesjaunes_publiee",
    action: `Actualite PagesJaunes publiee (${proposition.etablissement})`,
    resultat: "Confirmee comme publiee manuellement par l'utilisateur dans Solocal Manager.",
  });
  return miseAJour;
}
