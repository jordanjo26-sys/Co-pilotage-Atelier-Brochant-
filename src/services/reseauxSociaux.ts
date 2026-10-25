import { PrismaClient } from "@prisma/client";
import { obtenirConnexionMeta } from "./metaAuth";

/**
 * Publication et analyse de posts Facebook/Instagram (module Reseaux
 * sociaux, Phase "fondations"). Memes principes que googleAds.ts :
 * fonctions bas niveau ici, jamais appelees directement par Morgane -
 * uniquement via reseauxSociauxActions.ts, apres validation explicite de
 * l'utilisateur sur l'ecran dedie.
 *
 * Phase 1 volontairement limitee aux PHOTOS (pas de video) : Instagram
 * traite les videos de facon asynchrone (statut a interroger, delai
 * variable, contraintes Reels specifiques) - complexite remise a une
 * phase ulterieure plutot que de livrer quelque chose de fragile.
 */

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export function reseauxSociauxEstConfigure(): boolean {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_REDIRECT_URI);
}

interface ReponseGraph {
  error?: { message?: string };
  [cle: string]: unknown;
}

async function appelGraph<T extends ReponseGraph>(url: string, options?: RequestInit): Promise<T> {
  const reponse = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  const corps = (await reponse.json()) as T;
  if (!reponse.ok || corps.error) {
    throw new Error(corps.error?.message ?? `Erreur Graph API (${reponse.status}).`);
  }
  return corps;
}

/** Publie une photo (ou un texte seul si aucune URL de media) sur la Page Facebook. Retourne l'id du post publie. */
export async function publierFacebook(pageId: string, pageAccessToken: string, texte: string, urlMedia?: string): Promise<string> {
  if (urlMedia) {
    const { post_id, id } = await appelGraph<{ post_id?: string; id?: string }>(`${GRAPH_BASE}/${pageId}/photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlMedia, caption: texte, access_token: pageAccessToken }),
    });
    const idPost = post_id ?? id;
    if (!idPost) throw new Error("Facebook n'a renvoye aucun identifiant de publication.");
    return idPost;
  }

  const { id } = await appelGraph<{ id?: string }>(`${GRAPH_BASE}/${pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: texte, access_token: pageAccessToken }),
  });
  if (!id) throw new Error("Facebook n'a renvoye aucun identifiant de publication.");
  return id;
}

/**
 * Publie une photo sur Instagram (texte seul impossible sur ce reseau -
 * urlMedia est donc obligatoire ici, contrairement a Facebook). Flux en
 * deux temps impose par l'API : creation d'un conteneur media, puis
 * publication une fois son traitement termine (interroge par
 * courts intervalles, jusqu'a 20s avant d'abandonner).
 */
export async function publierInstagram(instagramUserId: string, pageAccessToken: string, texte: string, urlMedia: string): Promise<string> {
  const { id: idConteneur } = await appelGraph<{ id?: string }>(`${GRAPH_BASE}/${instagramUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: urlMedia, caption: texte, access_token: pageAccessToken }),
  });
  if (!idConteneur) throw new Error("Instagram n'a renvoye aucun identifiant de conteneur media.");

  let statut = "IN_PROGRESS";
  for (let tentative = 0; tentative < 10 && statut !== "FINISHED"; tentative++) {
    if (tentative > 0) await new Promise((r) => setTimeout(r, 2000));
    const { status_code } = await appelGraph<{ status_code?: string }>(
      `${GRAPH_BASE}/${idConteneur}?fields=status_code&access_token=${encodeURIComponent(pageAccessToken)}`
    );
    statut = status_code ?? "IN_PROGRESS";
    if (statut === "ERROR") throw new Error("Instagram a signale une erreur de traitement du media (format ou taille probablement invalide).");
  }
  if (statut !== "FINISHED") {
    throw new Error("Le media n'etait pas pret a temps cote Instagram (plus de 20s) - reessayer dans quelques minutes.");
  }

  const { id: idPublication } = await appelGraph<{ id?: string }>(`${GRAPH_BASE}/${instagramUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: idConteneur, access_token: pageAccessToken }),
  });
  if (!idPublication) throw new Error("Instagram n'a renvoye aucun identifiant de publication.");
  return idPublication;
}

export interface StatistiquesPost {
  idPublication: string;
  plateforme: "FACEBOOK" | "INSTAGRAM";
  likes: number;
  commentaires: number;
  partages: number | null; // non applicable sur Instagram
}

/** Statistiques de base d'une publication deja faite (lecture seule). */
export async function obtenirStatistiquesPost(prisma: PrismaClient, idPublication: string, plateforme: "FACEBOOK" | "INSTAGRAM"): Promise<StatistiquesPost> {
  const connexion = await obtenirConnexionMeta(prisma);
  if (!connexion) throw new Error("Reseaux sociaux non configures ou aucune Page connectee (se reconnecter via /auth/meta).");

  if (plateforme === "FACEBOOK") {
    const donnees = await appelGraph<{ likes?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } }; shares?: { count?: number } }>(
      `${GRAPH_BASE}/${idPublication}?fields=likes.summary(true),comments.summary(true),shares&access_token=${encodeURIComponent(connexion.pageAccessToken)}`
    );
    return {
      idPublication,
      plateforme,
      likes: donnees.likes?.summary?.total_count ?? 0,
      commentaires: donnees.comments?.summary?.total_count ?? 0,
      partages: donnees.shares?.count ?? 0,
    };
  }

  const donnees = await appelGraph<{ like_count?: number; comments_count?: number }>(
    `${GRAPH_BASE}/${idPublication}?fields=like_count,comments_count&access_token=${encodeURIComponent(connexion.pageAccessToken)}`
  );
  return {
    idPublication,
    plateforme,
    likes: donnees.like_count ?? 0,
    commentaires: donnees.comments_count ?? 0,
    partages: null,
  };
}

/**
 * Publie une proposition deja acceptee sur chacune de ses plateformes.
 * Chaque plateforme est tentee independamment : un echec sur l'une ne doit
 * pas empecher l'autre de passer (meme principe que l'enrichissement non
 * bloquant de creerCampagne dans googleAds.ts) - les identifiants publies
 * et les erreurs sont tous deux retournes, jamais l'un au prix de l'autre.
 */
export async function publierSurPlateformes(
  prisma: PrismaClient,
  plateformes: string[],
  texte: string,
  urlMedia: string | undefined
): Promise<{ idPublicationFacebook?: string; idPublicationInstagram?: string; avertissements: string[] }> {
  const connexion = await obtenirConnexionMeta(prisma);
  if (!connexion) throw new Error("Reseaux sociaux non configures ou aucune Page connectee (se reconnecter via /auth/meta).");

  const avertissements: string[] = [];
  let idPublicationFacebook: string | undefined;
  let idPublicationInstagram: string | undefined;

  if (plateformes.includes("FACEBOOK")) {
    try {
      idPublicationFacebook = await publierFacebook(connexion.pageId, connexion.pageAccessToken, texte, urlMedia);
    } catch (err) {
      avertissements.push(`Facebook : ${(err as Error).message}`);
    }
  }

  if (plateformes.includes("INSTAGRAM")) {
    if (!connexion.instagramBusinessAccountId) {
      avertissements.push("Instagram : aucun compte professionnel lie a la Page connectee.");
    } else if (!urlMedia) {
      avertissements.push("Instagram : une photo est obligatoire (texte seul impossible sur ce reseau).");
    } else {
      try {
        idPublicationInstagram = await publierInstagram(connexion.instagramBusinessAccountId, connexion.pageAccessToken, texte, urlMedia);
      } catch (err) {
        avertissements.push(`Instagram : ${(err as Error).message}`);
      }
    }
  }

  return { idPublicationFacebook, idPublicationInstagram, avertissements };
}
