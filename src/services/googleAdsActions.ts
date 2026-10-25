import { PrismaClient } from "@prisma/client";
import { changerStatutCampagne, changerStatutMotCle, creerCampagne, ajouterMotsClesExclus, changerComptageActionConversion, messageErreurGoogleAds } from "./googleAds";
import { logEvenement } from "./journalService";

/**
 * Propositions d'action sur une campagne Google Ads, formulees par Morgane
 * apres discussion avec l'utilisateur. Demande explicite de l'utilisateur :
 * Morgane ne doit jamais modifier une campagne directement depuis la
 * conversation - elle propose, et l'utilisateur valide ou refuse sur un
 * ecran dedie de l'application (src/api/routes.ts, routes /google-ads/propositions).
 * Rien n'est applique a Google Ads avant cette validation explicite.
 */

export type TypePropositionAds =
  | "pause_campagne"
  | "reactiver_campagne"
  | "creer_campagne"
  | "ajouter_mots_cles_exclus"
  | "pause_mot_cle"
  | "reactiver_mot_cle"
  | "exclure_action_conversion";

export interface PropositionAdsEntree {
  type: TypePropositionAds;
  campagneId: string; // vide ("") pour "creer_campagne" tant qu'elle n'existe pas encore
  campagneNom: string;
  justification: string;
  budgetQuotidien?: number;
  urlFinale?: string;
  titres?: string[];
  descriptions?: string[];
  motsCles?: string[];
  motsClesExclus?: string[];
  groupeId?: string; // requis pour pause_mot_cle/reactiver_mot_cle
  criterionId?: string; // requis pour pause_mot_cle/reactiver_mot_cle
  motCleTexte?: string; // requis pour pause_mot_cle/reactiver_mot_cle (affichage)
  conversionActionId?: string; // requis pour exclure_action_conversion
}

/**
 * Contraintes imposees par Google Ads elles-memes pour une annonce
 * responsive (3 a 15 titres, 2 a 4 descriptions) - verifiees ici pour
 * donner une erreur claire a Morgane avant meme de deposer la proposition,
 * plutot qu'un echec cryptique de l'API au moment de l'application.
 */
function validerEntreeCreationCampagne(entree: PropositionAdsEntree) {
  if (!entree.budgetQuotidien || entree.budgetQuotidien <= 0) throw new Error("budgetQuotidien doit etre un nombre positif.");
  if (!entree.urlFinale) throw new Error("urlFinale manquante.");
  const nbTitres = entree.titres?.length ?? 0;
  if (nbTitres < 3 || nbTitres > 15) throw new Error(`titres : ${nbTitres} fourni(s), il en faut entre 3 et 15.`);
  const nbDescriptions = entree.descriptions?.length ?? 0;
  if (nbDescriptions < 2 || nbDescriptions > 4) throw new Error(`descriptions : ${nbDescriptions} fournie(s), il en faut entre 2 et 4.`);
  if (!entree.motsCles || entree.motsCles.length === 0) throw new Error("motsCles : au moins un mot-cle pertinent est requis.");
}

export async function creerPropositionAds(prisma: PrismaClient, entree: PropositionAdsEntree) {
  if (entree.type === "creer_campagne") validerEntreeCreationCampagne(entree);
  if (entree.type === "ajouter_mots_cles_exclus") {
    if (!entree.campagneId) throw new Error("campagneId manquant (requis pour ajouter_mots_cles_exclus).");
    if (!entree.motsClesExclus || entree.motsClesExclus.length === 0) throw new Error("motsClesExclus : au moins un mot-cle est requis.");
  }
  if (entree.type === "pause_mot_cle" || entree.type === "reactiver_mot_cle") {
    if (!entree.groupeId) throw new Error(`groupeId manquant (requis pour ${entree.type}).`);
    if (!entree.criterionId) throw new Error(`criterionId manquant (requis pour ${entree.type}).`);
    if (!entree.motCleTexte) throw new Error(`motCleTexte manquant (requis pour ${entree.type}).`);
  }
  if (entree.type === "exclure_action_conversion") {
    if (!entree.conversionActionId) throw new Error("conversionActionId manquant (requis pour exclure_action_conversion).");
  }

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
    let campagneIdCreee: string | undefined;
    switch (proposition.type) {
      case "pause_campagne":
        await changerStatutCampagne(prisma, proposition.campagneId, "PAUSED");
        break;
      case "reactiver_campagne":
        await changerStatutCampagne(prisma, proposition.campagneId, "ENABLED");
        break;
      case "creer_campagne": {
        const resultat = await creerCampagne(prisma, {
          nom: proposition.campagneNom,
          budgetQuotidien: proposition.budgetQuotidien ?? 0,
          urlFinale: proposition.urlFinale ?? "",
          titres: proposition.titres,
          descriptions: proposition.descriptions,
          motsCles: proposition.motsCles,
          motsClesExclus: proposition.motsClesExclus,
        });
        campagneIdCreee = resultat.campagneId;
        break;
      }
      case "ajouter_mots_cles_exclus":
        await ajouterMotsClesExclus(prisma, proposition.campagneId, proposition.motsClesExclus);
        break;
      case "pause_mot_cle":
        await changerStatutMotCle(prisma, proposition.groupeId ?? "", proposition.criterionId ?? "", "PAUSED");
        break;
      case "reactiver_mot_cle":
        await changerStatutMotCle(prisma, proposition.groupeId ?? "", proposition.criterionId ?? "", "ENABLED");
        break;
      case "exclure_action_conversion":
        await changerComptageActionConversion(prisma, proposition.conversionActionId ?? "", false);
        break;
      default:
        throw new Error(`Type de proposition inconnu : "${proposition.type}".`);
    }

    const miseAJour = await prisma.propositionAds.update({
      where: { id },
      data: { statut: "appliquee", ...(campagneIdCreee ? { campagneId: campagneIdCreee } : {}) },
    });
    await logEvenement(prisma, {
      evenement: "proposition_ads_appliquee",
      action: `${proposition.type} : ${proposition.campagneNom}`,
      resultat:
        proposition.type === "creer_campagne"
          ? `Campagne creee avec succes (id ${campagneIdCreee}), en PAUSE - a activer manuellement dans Google Ads apres verification.`
          : proposition.type === "ajouter_mots_cles_exclus"
            ? `${proposition.motsClesExclus.length} mot(s)-cle(s) exclu(s) ajoute(s) : ${proposition.motsClesExclus.join(", ")}.`
            : proposition.type === "pause_mot_cle" || proposition.type === "reactiver_mot_cle"
              ? `Mot-cle "${proposition.motCleTexte}" ${proposition.type === "pause_mot_cle" ? "mis en pause" : "reactive"}.`
              : proposition.type === "exclure_action_conversion"
                ? `Action de conversion "${proposition.campagneNom}" retiree du comptage des conversions.`
                : "Applique avec succes sur Google Ads.",
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
