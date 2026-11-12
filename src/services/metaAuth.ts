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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} manquante. Creer une application sur developers.facebook.com (type "Entreprise"), ` +
        "ajouter les cas d'utilisation Instagram/Pages (produit \"Facebook Login for Business\"), " +
        "creer une configuration (Facebook Login for Business > Configurations) avec les autorisations " +
        "necessaires, puis renseigner META_APP_ID / META_APP_SECRET / META_REDIRECT_URI / META_CONFIG_ID dans .env."
    );
  }
  return value;
}

/**
 * Facebook Login for Business (obligatoire des qu'une app a les cas
 * d'utilisation Instagram/Pages, constate en production - voir
 * docs/architecture.md) remplace le parametre "scope" classique par un
 * identifiant de configuration (config_id) cree dans le Business Manager :
 * la configuration elle-meme definit quelles autorisations sont demandees.
 * override_default_response_type=true est exige par Meta avec ce flux.
 */
export function buildConsentUrl(): string {
  const appId = requireEnv("META_APP_ID");
  const redirectUri = requireEnv("META_REDIRECT_URI");
  const configId = requireEnv("META_CONFIG_ID");
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    config_id: configId,
    response_type: "code",
    override_default_response_type: "true",
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

  // La verification Instagram est faite "au mieux" : si la configuration
  // Facebook Login for Business ne porte pas encore l'autorisation
  // necessaire (pages_read_engagement ou equivalent - constate en
  // production, la configuration ne proposait que pages_show_list au
  // moment de sa creation), la Page se connecte quand meme sans Instagram
  // plutot que d'echouer entierement. Instagram pourra etre rattache plus
  // tard en relancant la connexion une fois la permission ajoutee.
  let compteInstagram: { id: string } | undefined;
  try {
    const reponse = await appelGraph<{ instagram_business_account?: { id: string } }>(
      `${GRAPH_BASE}/${page.id}?fields=instagram_business_account&access_token=${encodeURIComponent(page.access_token)}`
    );
    compteInstagram = reponse.instagram_business_account;
  } catch {
    compteInstagram = undefined;
  }

  let instagramUsername: string | null = null;
  if (compteInstagram?.id) {
    try {
      const { username } = await appelGraph<{ username?: string }>(
        `${GRAPH_BASE}/${compteInstagram.id}?fields=username&access_token=${encodeURIComponent(page.access_token)}`
      );
      instagramUsername = username ?? null;
    } catch {
      instagramUsername = null;
    }
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
