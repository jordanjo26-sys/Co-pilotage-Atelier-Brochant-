import { PrismaClient } from "@prisma/client";
import { publierSurPlateformes } from "./reseauxSociaux";
import { logEvenement } from "./journalService";

/**
 * Propositions de publication Reseaux sociaux, formulees par Morgane (ou
 * composees directement par l'utilisateur dans l'onglet dedie) et
 * TOUJOURS validees explicitement avant publication reelle. Meme
 * architecture que googleAdsActions.ts : aucune publication sur Facebook
 * ou Instagram n'est jamais declenchee directement depuis la conversation.
 */

export interface PropositionPostEntree {
  plateformes: string[]; // "FACEBOOK" et/ou "INSTAGRAM"
  texte: string;
  cheminMedia?: string;
  justification: string;
}

export async function creerPropositionPost(prisma: PrismaClient, entree: PropositionPostEntree) {
  const plateformesValides = entree.plateformes.filter((p) => p === "FACEBOOK" || p === "INSTAGRAM");
  if (plateformesValides.length === 0) throw new Error("plateformes : au moins une plateforme valide (FACEBOOK ou INSTAGRAM) est requise.");
  if (!entree.texte) throw new Error("texte manquant.");
  if (plateformesValides.includes("INSTAGRAM") && !entree.cheminMedia) {
    throw new Error("cheminMedia manquant : Instagram exige une photo, le texte seul n'est pas publiable sur ce reseau.");
  }

  const proposition = await prisma.propositionPost.create({
    data: { plateformes: plateformesValides, texte: entree.texte, cheminMedia: entree.cheminMedia ?? null, justification: entree.justification },
  });

  await logEvenement(prisma, {
    evenement: "proposition_post_creee",
    action: `Nouvelle publication (${plateformesValides.join(", ")})`,
    resultat: entree.justification,
  });

  return proposition;
}

export async function listerPropositionsPost(prisma: PrismaClient, statut?: string) {
  return prisma.propositionPost.findMany({
    where: statut ? { statut } : undefined,
    orderBy: { creeLe: "desc" },
  });
}

export async function appliquerPropositionPost(prisma: PrismaClient, id: string) {
  const proposition = await prisma.propositionPost.findUnique({ where: { id } });
  if (!proposition) throw new Error("Proposition introuvable.");
  if (proposition.statut !== "acceptee") {
    throw new Error(`Cette proposition est au statut "${proposition.statut}", pas "acceptee" - impossible de l'appliquer.`);
  }

  try {
    const urlMedia = proposition.cheminMedia ? `${requireBaseUrl()}/${proposition.cheminMedia}` : undefined;
    const resultat = await publierSurPlateformes(prisma, proposition.plateformes, proposition.texte, urlMedia);

    // Au moins une plateforme doit avoir reussi pour marquer "appliquee" -
    // sinon (toutes en echec), c'est un vrai echec, pas juste un
    // avertissement annexe (contrairement aux etapes d'enrichissement non
    // bloquantes de creerCampagne : ici, publier est le coeur de l'action).
    const succes = Boolean(resultat.idPublicationFacebook || resultat.idPublicationInstagram);
    if (!succes) {
      throw new Error(resultat.avertissements.join(" | ") || "Aucune plateforme n'a pu publier.");
    }

    const miseAJour = await prisma.propositionPost.update({
      where: { id },
      data: {
        statut: "appliquee",
        idPublicationFacebook: resultat.idPublicationFacebook ?? null,
        idPublicationInstagram: resultat.idPublicationInstagram ?? null,
      },
    });

    await logEvenement(prisma, {
      evenement: "proposition_post_appliquee",
      action: `Publication (${proposition.plateformes.join(", ")})`,
      resultat:
        `Publie avec succes.` +
        (resultat.idPublicationFacebook ? ` Facebook : ${resultat.idPublicationFacebook}.` : "") +
        (resultat.idPublicationInstagram ? ` Instagram : ${resultat.idPublicationInstagram}.` : "") +
        (resultat.avertissements.length > 0 ? ` Points a corriger separement : ${resultat.avertissements.join(" | ")}` : ""),
    });
    return miseAJour;
  } catch (err) {
    const erreur = (err as Error).message;
    const miseAJour = await prisma.propositionPost.update({
      where: { id },
      data: { statut: "echec", erreur },
    });
    await logEvenement(prisma, {
      evenement: "proposition_post_echec",
      action: `Publication (${proposition.plateformes.join(", ")})`,
      resultat: erreur,
    });
    return miseAJour;
  }
}

export async function accepterPropositionPost(prisma: PrismaClient, id: string) {
  const proposition = await prisma.propositionPost.findUnique({ where: { id } });
  if (!proposition) throw new Error("Proposition introuvable.");
  if (proposition.statut !== "en_attente") {
    throw new Error(`Cette proposition est au statut "${proposition.statut}", pas "en_attente".`);
  }

  await prisma.propositionPost.update({ where: { id }, data: { statut: "acceptee", decideLe: new Date() } });
  return appliquerPropositionPost(prisma, id);
}

export async function refuserPropositionPost(prisma: PrismaClient, id: string) {
  const proposition = await prisma.propositionPost.findUnique({ where: { id } });
  if (!proposition) throw new Error("Proposition introuvable.");
  if (proposition.statut !== "en_attente") {
    throw new Error(`Cette proposition est au statut "${proposition.statut}", pas "en_attente".`);
  }

  return prisma.propositionPost.update({ where: { id }, data: { statut: "refusee", decideLe: new Date() } });
}

/**
 * URL publique de base pour servir les medias uploades (sitelink/photo de
 * post...) - Facebook/Instagram recuperent le fichier depuis cette URL,
 * elle doit donc etre joignable sans authentification (voir
 * /media-publics/ dans la configuration nginx, exempte du mot de passe
 * global du site comme /telephonie/ l'est deja pour Twilio).
 */
function requireBaseUrl(): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) {
    throw new Error("PUBLIC_BASE_URL manquante dans .env (ex. https://copilotage-brochant.fr) - necessaire pour exposer les medias a Facebook/Instagram.");
  }
  return base.replace(/\/$/, "");
}
