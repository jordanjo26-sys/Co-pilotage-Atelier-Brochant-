import { PrismaClient } from "@prisma/client";
import { chiffrer, dechiffrer } from "./cipher";

/**
 * Connexion OAuth a une Page Facebook (et au compte Instagram professionnel
 * qui lui est lie) - module Reseaux sociaux, demande explicite de
 * l'utilisateur : creer/publier/analyser des posts Facebook et Instagram.
 * Meme principe que googleAuth.ts : jamais de mot de passe, OAuth avec
 * permissions minimales, secret chiffre au repos (cipher.ts).
 *
 * Prerequis cote utilisateur (hors de notre controle, comme le jeton
 * developpeur Google Ads a l'epoque) : une Page Facebook professionnelle,
 * un compte Instagram PROFESSIONNEL/CREATEUR lie a cette Page, et une
 * application "Meta for Developers" (developers.facebook.com) fournissant
 * META_APP_ID/META_APP_SECRET.
 */

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// pages_show_list : lister les Pages gerees par l'utilisateur.
// pages_read_engagement + pages_manage_posts : lire/publier sur la Page.
// instagram_basic + instagram_content_publish : lire/publier sur le
// compte Instagram professionnel lie a la Page.
const SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} manquante. Creer une application sur developers.facebook.com (type "Entreprise"), ` +
        "ajouter le produit \"Connexion Facebook pour les entreprises\", puis renseigner " +
        "META_APP_ID / META_APP_SECRET / META_REDIRECT_URI dans .env."
    );
  }
  return value;
}

export function buildConsentUrl(): string {
  const appId = requireEnv("META_APP_ID");
  const redirectUri = requireEnv("META_REDIRECT_URI");
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: SCOPES.join(","),
    response_type: "code",
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

interface ReponseGraph {
  error?: { message?: string; type?: string; code?: number };
  [cle: string]: unknown;
}

async function appelGraph<T extends ReponseGraph>(url: string): Promise<T> {
  const reponse = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const corps = (await reponse.json()) as T;
  if (!reponse.ok || corps.error) {
    throw new Error(corps.error?.message ?? `Erreur Graph API (${reponse.status}).`);
  }
  return corps;
}

/**
 * Echange le code d'autorisation contre un jeton utilisateur, le convertit
 * en jeton longue duree (environ 60 jours), recupere la premiere Page geree
 * par l'utilisateur avec son jeton de Page (qui n'expire pas tant que le
 * jeton utilisateur longue duree reste valide), et le compte Instagram
 * professionnel lie a cette Page s'il existe.
 */
export async function handleOAuthCallback(prisma: PrismaClient, code: string): Promise<{ pageNom: string; instagramUsername: string | null }> {
  const appId = requireEnv("META_APP_ID");
  const appSecret = requireEnv("META_APP_SECRET");
  const redirectUri = requireEnv("META_REDIRECT_URI");

  const echangeParams = new URLSearchParams({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code });
  const { access_token: jetonUtilisateur } = await appelGraph<{ access_token: string }>(`${GRAPH_BASE}/oauth/access_token?${echangeParams.toString()}`);

  const longueDureeParams = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: jetonUtilisateur,
  });
  const { access_token: jetonLongueDuree } = await appelGraph<{ access_token: string }>(`${GRAPH_BASE}/oauth/access_token?${longueDureeParams.toString()}`);

  const { data: pages } = await appelGraph<{ data: Array<{ id: string; name: string; access_token: string }> }>(
    `${GRAPH_BASE}/me/accounts?access_token=${encodeURIComponent(jetonLongueDuree)}`
  );
  const page = pages[0];
  if (!page) {
    throw new Error("Aucune Page Facebook geree par ce compte. Il faut etre administrateur d'au moins une Page Facebook professionnelle.");
  }

  const { instagram_business_account: compteInstagram } = await appelGraph<{ instagram_business_account?: { id: string } }>(
    `${GRAPH_BASE}/${page.id}?fields=instagram_business_account&access_token=${encodeURIComponent(page.access_token)}`
  );

  let instagramUsername: string | null = null;
  if (compteInstagram?.id) {
    const { username } = await appelGraph<{ username?: string }>(
      `${GRAPH_BASE}/${compteInstagram.id}?fields=username&access_token=${encodeURIComponent(page.access_token)}`
    );
    instagramUsername = username ?? null;
  }

  await prisma.connexionMeta.upsert({
    where: { pageId: page.id },
    update: {
      pageNom: page.name,
      pageAccessTokenChiffre: chiffrer(page.access_token),
      instagramBusinessAccountId: compteInstagram?.id ?? null,
      instagramUsername,
      actif: true,
    },
    create: {
      pageId: page.id,
      pageNom: page.name,
      pageAccessTokenChiffre: chiffrer(page.access_token),
      instagramBusinessAccountId: compteInstagram?.id ?? null,
      instagramUsername,
    },
  });

  return { pageNom: page.name, instagramUsername };
}

export interface ConnexionMetaActive {
  pageId: string;
  pageNom: string;
  pageAccessToken: string;
  instagramBusinessAccountId: string | null;
  instagramUsername: string | null;
}

/** Retourne la connexion Meta active, ou null si aucune Page n'est connectee. */
export async function obtenirConnexionMeta(prisma: PrismaClient): Promise<ConnexionMetaActive | null> {
  const connexion = await prisma.connexionMeta.findFirst({ where: { actif: true } });
  if (!connexion) return null;
  return {
    pageId: connexion.pageId,
    pageNom: connexion.pageNom,
    pageAccessToken: dechiffrer(connexion.pageAccessTokenChiffre),
    instagramBusinessAccountId: connexion.instagramBusinessAccountId,
    instagramUsername: connexion.instagramUsername,
  };
}
