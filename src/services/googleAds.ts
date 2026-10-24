import { GoogleAdsApi, Customer, fromMicros } from "google-ads-api";
import { PrismaClient } from "@prisma/client";
import { dechiffrer } from "./cipher";

/**
 * Acces en lecture seule aux campagnes Google Ads (demande explicite de
 * l'utilisateur : "un agent capable d'analyser toutes mes campagnes en
 * ligne"). Phase 1 volontairement limitee a la lecture : aucune fonction
 * ici ne modifie une campagne, un budget ou une enchere - voir la
 * discussion avec l'utilisateur, qui a choisi de commencer par l'analyse
 * seule avant d'ajouter la capacite d'agir.
 *
 * Reutilise la connexion Google deja etablie pour Gmail/Calendar (meme
 * refresh token, scope "adwords" ajoute a GMAIL_SCOPES dans
 * googleAuth.ts) : pas de deuxieme ecran de connexion a gerer. Le jeton
 * developpeur et les identifiants de compte restent eux des secrets
 * d'application (comme STRIPE_API_KEY ou les identifiants Synec), pas lies
 * a un utilisateur precis.
 *
 * Compte gestionnaire (MCC) necessaire : le centre API de Google Ads n'est
 * accessible que depuis un compte gestionnaire (confirme en pratique avec
 * l'utilisateur, le compte Ads existant etant autonome) - d'ou
 * GOOGLE_ADS_LOGIN_CUSTOMER_ID distinct de GOOGLE_ADS_CUSTOMER_ID.
 */

export function googleAdsEstConfigure(): boolean {
  return Boolean(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_ADS_CUSTOMER_ID && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );
}

/**
 * Construit un client Google Ads authentifie a partir de la connexion
 * Google active (meme principe que getGmailClient). Retourne null si Ads
 * n'est pas configure ou si aucune boite Google n'est connectee - jamais
 * d'erreur ici, c'est a l'appelant de decider comment reagir (Morgane
 * explique simplement que ce n'est pas encore configure).
 */
async function obtenirClientAds(prisma: PrismaClient): Promise<Customer | null> {
  if (!googleAdsEstConfigure()) return null;

  const connexion = await prisma.gmailConnexion.findFirst({ where: { actif: true } });
  if (!connexion) return null;

  const client = new GoogleAdsApi({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
  });

  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/-/g, "");
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, "");

  return client.Customer({
    customer_id: customerId,
    // Echec reel ("authorization_error":2, "User doesn't have permission to
    // access customer") : contrairement a l'hypothese de depart ("compte
    // gestionnaire necessaire pour le Centre API"), confirme par
    // l'utilisateur qu'il n'existe en realite QU'UN SEUL compte Google Ads
    // (pas de structure gestionnaire+client separee - "Atelier Brochant" ne
    // possede aucun compte propre). Envoyer un login_customer_id identique
    // au customer_id cible n'a pas de sens pour l'API (l'en-tete sert a
    // s'identifier comme un AUTRE compte gestionnaire) - ne l'envoie que
    // s'il differe reellement.
    login_customer_id: loginCustomerId && loginCustomerId !== customerId ? loginCustomerId : undefined,
    refresh_token: dechiffrer(connexion.refreshTokenChiffre),
  });
}

/**
 * Message d'erreur exploitable pour un echec d'appel a listerCampagnesAds.
 *
 * La librairie google-ads-api ne leve pas toujours une Error standard : des
 * qu'un trailer gRPC "GoogleAdsFailure" accompagne l'echec (ex. jeton
 * developpeur pas encore approuve, acces refuse...), elle leve directement
 * l'objet protobuf decode, qui n'a pas de propriete .message - d'ou le
 * "undefined" observe jusqu'ici dans le Journal (err.message sur cet objet).
 * Le vrai detail est dans err.errors[0].message.
 */
export function messageErreurGoogleAds(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { errors?: unknown; message?: unknown; details?: unknown };
    if (Array.isArray(e.errors) && e.errors.length > 0) {
      const premiere = e.errors[0] as { message?: unknown; error_code?: unknown };
      if (typeof premiere?.message === "string" && premiere.message) {
        const code = premiere.error_code ? ` (${JSON.stringify(premiere.error_code)})` : "";
        return `${premiere.message}${code}`;
      }
    }
    if (typeof e.message === "string" && e.message) return e.message;
    if (typeof e.details === "string" && e.details) return e.details;
  }
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export interface CampagneAds {
  id: string;
  nom: string;
  statut: string;
  type: string;
  budgetQuotidien: number | null;
  impressions: number;
  clics: number;
  cout: number;
  conversions: number;
  ctr: number;
  cpcMoyen: number;
}

/** "AAAA-MM-JJ BETWEEN AAAA-MM-JJ" en GAQL, sur les `jours` derniers jours (bornes incluses). */
export function clauseFenetreDate(jours: number): string {
  const fin = new Date();
  const debut = new Date();
  debut.setDate(debut.getDate() - jours);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return `BETWEEN '${fmt(debut)}' AND '${fmt(fin)}'`;
}

/**
 * Liste les campagnes avec leurs indicateurs agreges sur la fenetre
 * demandee (30 jours par defaut). Exclut les campagnes supprimees
 * (REMOVED) : sans interet pour une analyse de performance actuelle.
 * N'incluant pas segments.date dans la selection, GAQL retourne une seule
 * ligne agregee par campagne sur toute la fenetre plutot qu'une ligne par
 * jour.
 */
export async function listerCampagnesAds(prisma: PrismaClient, jours = 30): Promise<CampagneAds[]> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error(
      "Google Ads non configure (jeton developpeur/numero de compte manquant) ou aucune boite Google connectee (se reconnecter via /auth/google)."
    );
  }

  const lignes = await customer.query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign_budget.amount_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.ctr,
      metrics.average_cpc
    FROM campaign
    WHERE segments.date ${clauseFenetreDate(jours)}
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
  `);

  return lignes.map((ligne) => ({
    id: String(ligne.campaign?.id ?? ""),
    nom: ligne.campaign?.name ?? "",
    statut: String(ligne.campaign?.status ?? ""),
    type: String(ligne.campaign?.advertising_channel_type ?? ""),
    budgetQuotidien: ligne.campaign_budget?.amount_micros != null ? fromMicros(Number(ligne.campaign_budget.amount_micros)) : null,
    impressions: Number(ligne.metrics?.impressions ?? 0),
    clics: Number(ligne.metrics?.clicks ?? 0),
    cout: fromMicros(Number(ligne.metrics?.cost_micros ?? 0)),
    conversions: Number(ligne.metrics?.conversions ?? 0),
    ctr: Number(ligne.metrics?.ctr ?? 0),
    cpcMoyen: fromMicros(Number(ligne.metrics?.average_cpc ?? 0)),
  }));
}
