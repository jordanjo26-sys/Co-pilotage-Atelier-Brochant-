import { PrismaClient } from "@prisma/client";
import { changerStatutCampagne, messageErreurGoogleAds } from "./googleAds";
import { logEvenement } from "./journalService";

/**
 * Propositions d'action sur une campagne Google Ads, formulees par Morgane
 * apres discussion avec l'utilisateur. Demande explicite de l'utilisateur :
 * Morgane ne doit jamais modifier une campagne directement depuis la
 * conversation - elle propose, et l'utilisateur valide ou refuse sur un
 * ecran dedie de l'application (src/api/routes.ts, routes /google-ads/propositions).
 * Rien n'est applique a Google Ads avant cette validation explicite.
 */

export type TypePropositionAds = "pause_campagne" | "reactiver_campagne";

export interface PropositionAdsEntree {
  type: TypePropositionAds;
  campagneId: string;
  campagneNom: string;
  justification: string;
}

export async function creerPropositionAds(prisma: PrismaClient, entree: PropositionAdsEntree) {
  const proposition = await prisma.propositionAds.create({ data: entree });

  await logEvenement(prisma, {
    evenement: "proposition_ads_creee",
    action: `${entree.type} : ${entree.campagneNom}`,
    resultat: entree.justification,
  });

  return proposition;
}

export async function listerPropositionsAds(prisma: PrismaClient, statut?: string) {
  return prisma.propositionAds.findMany({
    where: statut ? { statut } : undefined,
    orderBy: { creeLe: "desc" },
  });
}

/**
 * Applique une proposition deja acceptee : execute reellement la
 * modification sur Google Ads, puis marque la proposition "appliquee" ou
 * "echec" (jamais supprimee, pour garder une trace complete).
 */
export async function appliquerPropositionAds(prisma: PrismaClient, id: string) {
  const proposition = await prisma.propositionAds.findUnique({ where: { id } });
  if (!proposition) throw new Error("Proposition introuvable.");
  if (proposition.statut !== "acceptee") {
    throw new Error(`Cette proposition est au statut "${proposition.statut}", pas "acceptee" - impossible de l'appliquer.`);
  }

  try {
    switch (proposition.type) {
      case "pause_campagne":
        await changerStatutCampagne(prisma, proposition.campagneId, "PAUSED");
        break;
      case "reactiver_campagne":
        await changerStatutCampagne(prisma, proposition.campagneId, "ENABLED");
        break;
      default:
        throw new Error(`Type de proposition inconnu : "${proposition.type}".`);
    }

    const miseAJour = await prisma.propositionAds.update({
      where: { id },
      data: { statut: "appliquee" },
    });
    await logEvenement(prisma, {
      evenement: "proposition_ads_appliquee",
      action: `${proposition.type} : ${proposition.campagneNom}`,
      resultat: "Applique avec succes sur Google Ads.",
    });
    return miseAJour;
  } catch (err) {
    const erreur = messageErreurGoogleAds(err);
    const miseAJour = await prisma.propositionAds.update({
      where: { id },
      data: { statut: "echec", erreur },
    });
    await logEvenement(prisma, {
      evenement: "proposition_ads_echec",
      action: `${proposition.type} : ${proposition.campagneNom}`,
      resultat: erreur,
    });
    return miseAJour;
  }
}

/** Accepte une proposition en attente, puis l'applique immediatement. */
export async function accepterPropositionAds(prisma: PrismaClient, id: string) {
  const proposition = await prisma.propositionAds.findUnique({ where: { id } });
  if (!proposition) throw new Error("Proposition introuvable.");
  if (proposition.statut !== "en_attente") {
    throw new Error(`Cette proposition est au statut "${proposition.statut}", pas "en_attente".`);
  }

  await prisma.propositionAds.update({
    where: { id },
    data: { statut: "acceptee", decideLe: new Date() },
  });

  return appliquerPropositionAds(prisma, id);
}

export async function refuserPropositionAds(prisma: PrismaClient, id: string) {
  const proposition = await prisma.propositionAds.findUnique({ where: { id } });
  if (!proposition) throw new Error("Proposition introuvable.");
  if (proposition.statut !== "en_attente") {
    throw new Error(`Cette proposition est au statut "${proposition.statut}", pas "en_attente".`);
  }

  return prisma.propositionAds.update({
    where: { id },
    data: { statut: "refusee", decideLe: new Date() },
  });
}
