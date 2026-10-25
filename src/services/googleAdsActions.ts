import { Prisma, PrismaClient } from "@prisma/client";
import {
  changerStatutCampagne,
  changerStatutMotCle,
  creerCampagne,
  ajouterMotsClesExclus,
  changerComptageActionConversion,
  creerActionConversionSite,
  TypeActionConversionSite,
  changerBudgetCampagne,
  ajouterMotsClesPositifs,
  ajouterExtensionsCampagne,
  SitelinkAds,
  StructuredSnippetAds,
  messageErreurGoogleAds,
} from "./googleAds";
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
  | "exclure_action_conversion"
  | "creer_action_conversion_site"
  | "modifier_budget_campagne"
  | "ajouter_mots_cles_positifs"
  | "ajouter_extensions_campagne";

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
  groupeId?: string; // requis pour pause_mot_cle/reactiver_mot_cle/ajouter_mots_cles_positifs
  criterionId?: string; // requis pour pause_mot_cle/reactiver_mot_cle
  motCleTexte?: string; // requis pour pause_mot_cle/reactiver_mot_cle (affichage)
  conversionActionId?: string; // requis pour exclure_action_conversion ; rempli apres creation pour creer_action_conversion_site
  typeConversionSite?: TypeActionConversionSite; // requis pour creer_action_conversion_site
  ciblesGeographiques?: string[]; // noms de lieux a cibler, optionnel pour creer_campagne
  numeroTelephone?: string; // pour l'extension d'appel a la creation, optionnel pour creer_campagne
  typeCorrespondance?: "EXACT" | "PHRASE" | "BROAD"; // optionnel pour creer_campagne/ajouter_mots_cles_positifs (defaut PHRASE)
  sitelinks?: SitelinkAds[]; // optionnel pour creer_campagne et ajouter_extensions_campagne
  callouts?: string[]; // optionnel pour creer_campagne et ajouter_extensions_campagne
  structuredSnippets?: StructuredSnippetAds[]; // optionnel pour creer_campagne et ajouter_extensions_campagne
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
  if (entree.type === "creer_action_conversion_site") {
    if (entree.typeConversionSite !== "CLICK_TO_CALL" && entree.typeConversionSite !== "WEBPAGE") {
      throw new Error("typeConversionSite manquant ou invalide (requis : CLICK_TO_CALL ou WEBPAGE).");
    }
  }
  if (entree.type === "modifier_budget_campagne") {
    if (!entree.campagneId) throw new Error("campagneId manquant (requis pour modifier_budget_campagne).");
    if (!entree.budgetQuotidien || entree.budgetQuotidien <= 0) throw new Error("budgetQuotidien doit etre un nombre positif (nouveau budget quotidien).");
  }
  if (entree.type === "ajouter_mots_cles_positifs") {
    if (!entree.campagneId) throw new Error("campagneId manquant (requis pour ajouter_mots_cles_positifs).");
    if (!entree.groupeId) throw new Error("groupeId manquant (requis pour ajouter_mots_cles_positifs).");
    if (!entree.motsCles || entree.motsCles.length === 0) throw new Error("motsCles : au moins un mot-cle est requis.");
  }
  if (entree.type === "ajouter_extensions_campagne") {
    if (!entree.campagneId) throw new Error("campagneId manquant (requis pour ajouter_extensions_campagne).");
    const nbExtensions = (entree.sitelinks?.length ?? 0) + (entree.callouts?.length ?? 0) + (entree.structuredSnippets?.length ?? 0);
    if (nbExtensions === 0) throw new Error("Au moins un sitelink, une accroche (callout) ou un extrait structure est requis.");
  }

  // sitelinks/structuredSnippets sont des tableaux d'objets structures,
  // stockes en colonne Json - Prisma attend InputJsonValue pour ce champ,
  // que le typage structurel de SitelinkAds[]/StructuredSnippetAds[] ne
  // satisfait pas directement (pas de signature d'index), d'ou ce
  // contournement de typage ; la forme reelle des donnees ne change pas.
  const proposition = await prisma.propositionAds.create({
    data: entree as unknown as Prisma.PropositionAdsCreateInput,
  });

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
    let conversionActionIdCreee: string | undefined;
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
          typeCorrespondance: (proposition.typeCorrespondance as "EXACT" | "PHRASE" | "BROAD" | null) ?? undefined,
          ciblesGeographiques: proposition.ciblesGeographiques.length > 0 ? proposition.ciblesGeographiques : undefined,
          numeroTelephone: proposition.numeroTelephone ?? undefined,
          sitelinks: (proposition.sitelinks as unknown as SitelinkAds[] | null) ?? undefined,
          callouts: proposition.callouts.length > 0 ? proposition.callouts : undefined,
          structuredSnippets: (proposition.structuredSnippets as unknown as StructuredSnippetAds[] | null) ?? undefined,
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
      case "creer_action_conversion_site": {
        const resultat = await creerActionConversionSite(prisma, proposition.campagneNom, (proposition.typeConversionSite as TypeActionConversionSite) ?? "WEBPAGE");
        conversionActionIdCreee = resultat.id;
        break;
      }
      case "modifier_budget_campagne":
        await changerBudgetCampagne(prisma, proposition.campagneId, proposition.budgetQuotidien ?? 0);
        break;
      case "ajouter_mots_cles_positifs":
        await ajouterMotsClesPositifs(
          prisma,
          proposition.groupeId ?? "",
          proposition.motsCles,
          (proposition.typeCorrespondance as "EXACT" | "PHRASE" | "BROAD" | null) ?? "PHRASE"
        );
        break;
      case "ajouter_extensions_campagne":
        await ajouterExtensionsCampagne(prisma, proposition.campagneId, {
          sitelinks: (proposition.sitelinks as unknown as SitelinkAds[] | null) ?? undefined,
          callouts: proposition.callouts.length > 0 ? proposition.callouts : undefined,
          structuredSnippets: (proposition.structuredSnippets as unknown as StructuredSnippetAds[] | null) ?? undefined,
        });
        break;
      default:
        throw new Error(`Type de proposition inconnu : "${proposition.type}".`);
    }

    const miseAJour = await prisma.propositionAds.update({
      where: { id },
      data: {
        statut: "appliquee",
        ...(campagneIdCreee ? { campagneId: campagneIdCreee } : {}),
        ...(conversionActionIdCreee ? { conversionActionId: conversionActionIdCreee } : {}),
      },
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
                : proposition.type === "creer_action_conversion_site"
                  ? `Action de conversion "${proposition.campagneNom}" creee (id ${conversionActionIdCreee}) - utilise obtenir_snippet_conversion_ads avec cet id pour recuperer le code a coller sur le site.`
                  : proposition.type === "modifier_budget_campagne"
                    ? `Budget quotidien de "${proposition.campagneNom}" change a ${proposition.budgetQuotidien} EUR/jour.`
                    : proposition.type === "ajouter_mots_cles_positifs"
                      ? `${proposition.motsCles.length} mot(s)-cle(s) positif(s) ajoute(s) : ${proposition.motsCles.join(", ")}.`
                      : proposition.type === "ajouter_extensions_campagne"
                        ? `Extensions ajoutees a "${proposition.campagneNom}" : ${(proposition.sitelinks as unknown as SitelinkAds[] | null)?.length ?? 0} sitelink(s), ${proposition.callouts.length} accroche(s), ${(proposition.structuredSnippets as unknown as StructuredSnippetAds[] | null)?.length ?? 0} extrait(s) structure(s).`
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
