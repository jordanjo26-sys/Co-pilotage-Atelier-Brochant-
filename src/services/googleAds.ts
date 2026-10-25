import { GoogleAdsApi, Customer, fromMicros, toMicros, enums, ResourceNames } from "google-ads-api";
import { PrismaClient } from "@prisma/client";
import { dechiffrer } from "./cipher";
import { buildOAuthClient, ADS_SCOPE } from "./googleAuth";

/**
 * Acces aux campagnes Google Ads (demande explicite de l'utilisateur : "un
 * agent capable d'analyser toutes mes campagnes en ligne"). Phase 1 en
 * lecture seule ; phase 2 (ce fichier) ajoute la capacite de modifier une
 * campagne (ex. pause/reactivation), mais UNIQUEMENT via
 * src/services/googleAdsActions.ts : aucune fonction de ce fichier n'est
 * appelee directement par Morgane pour agir - elle passe toujours par une
 * proposition, validee par l'utilisateur sur un ecran dedie, jamais une
 * execution immediate depuis la conversation (demande explicite de
 * l'utilisateur).
 *
 * Reutilise la connexion Google deja etablie pour Gmail/Calendar (meme
 * refresh token, scope "adwords" ajoute a GMAIL_SCOPES dans
 * googleAuth.ts) : pas de deuxieme ecran de connexion a gerer. Le jeton
 * developpeur et les identifiants de compte restent eux des secrets
 * d'application (comme STRIPE_API_KEY ou les identifiants Synec), pas lies
 * a un utilisateur precis.
 *
 * Compte gestionnaire (MCC) : ATELIER BROCHANT GESTION (962-510-7482) gere
 * le compte client Help-Services (415-772-4879) - d'ou
 * GOOGLE_ADS_LOGIN_CUSTOMER_ID distinct de GOOGLE_ADS_CUSTOMER_ID. L'acces
 * utilisateur doit etre accorde sur le compte GESTIONNAIRE lui-meme (pas
 * seulement sur le client) pour que l'API fonctionne.
 */

export function googleAdsEstConfigure(): boolean {
  return Boolean(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_ADS_CUSTOMER_ID && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );
}

/**
 * Diagnostic (echec reel persistant, "authorization_error":2, identique
 * avant et apres correction des numeros de compte + octroi d'acces +
 * approbation de l'acces Basic du jeton developpeur) : expose les valeurs
 * REELLEMENT utilisees par le serveur deploye, pour confirmer sans deviner
 * qu'elles correspondent bien a ce qui a ete configure cote GitHub.
 */
export function diagnosticConfigurationAds(): string {
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID?.replace(/-/g, "") ?? "(absent)";
  const loginCustomerIdBrut = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "(absent)";
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, "") ?? "(absent)";
  const tokenLongueur = process.env.GOOGLE_ADS_DEVELOPER_TOKEN?.length ?? 0;
  return `customer_id="${customerId}", login_customer_id (brut)="${loginCustomerIdBrut}", login_customer_id (envoyé)="${loginCustomerId === customerId ? "(omis, identique au customer_id)" : loginCustomerId}", longueur du jeton développeur=${tokenLongueur}`;
}

/**
 * Diagnostic complementaire : interroge DIRECTEMENT Google (endpoint
 * tokeninfo), independamment de la librairie google-ads-api, pour voir les
 * scopes REELLEMENT accordes sur le jeton d'acces genere a partir du
 * refresh_token stocke. Objectif : confirmer sans deviner que le scope
 * "adwords" est bien present sur le jeton utilise par le serveur deploye
 * (toutes les autres pistes - comptes, acces Basic, acces utilisateur -
 * etant deja verifiees correctes sans que l'erreur authorization_error:2
 * ne disparaisse).
 */
export async function diagnosticScopesJeton(prisma: PrismaClient): Promise<string> {
  const connexion = await prisma.gmailConnexion.findFirst({ where: { actif: true } });
  if (!connexion) return "aucune connexion Google active";

  const client = buildOAuthClient();
  client.setCredentials({ refresh_token: dechiffrer(connexion.refreshTokenChiffre) });

  try {
    const { token } = await client.getAccessToken();
    if (!token) return "echec : getAccessToken() n'a retourne aucun jeton";

    const reponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
    const corps = (await reponse.json()) as { scope?: string; email?: string; azp?: string; expires_in?: number };
    if (!reponse.ok) return `tokeninfo a echoue (${reponse.status}) : ${JSON.stringify(corps)}`;

    const scopes = typeof corps.scope === "string" ? corps.scope.split(" ") : [];
    const possedeAdwords = scopes.includes(ADS_SCOPE);
    return `scope "adwords" present=${possedeAdwords}, compte=${corps.email ?? corps.azp ?? "?"}, expire_in=${corps.expires_in ?? "?"}s, tous les scopes="${scopes.join(", ")}"`;
  } catch (err) {
    return `echec de la verification tokeninfo : ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Diagnostic complementaire : interroge le compte GESTIONNAIRE sur SA
 * PROPRE vue de ses comptes clients (customer_client), sans
 * login_customer_id (on s'authentifie directement comme le gestionnaire
 * lui-meme). Objectif : lire le statut REEL du lien gestionnaire-client
 * (ACTIVE/PENDING/REFUSED/CANCELED), qui est une notion distincte des
 * acces utilisateur individuels deja verifies - et confirmer au passage
 * que le jeton a bien acces au compte gestionnaire lui-meme.
 */
export async function diagnosticLienGestionnaire(prisma: PrismaClient): Promise<string> {
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, "");
  if (!loginCustomerId) return "GOOGLE_ADS_LOGIN_CUSTOMER_ID absent";

  const connexion = await prisma.gmailConnexion.findFirst({ where: { actif: true } });
  if (!connexion) return "aucune connexion Google active";

  const client = new GoogleAdsApi({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
  });

  const gestionnaire = client.Customer({
    customer_id: loginCustomerId,
    refresh_token: dechiffrer(connexion.refreshTokenChiffre),
  });

  const prefixe = `compte Google connecte (gmailConnexion.compteEmail)="${connexion.compteEmail}" - `;
  try {
    const lignes = await gestionnaire.query(`
      SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.status, customer_client.manager, customer_client.level
      FROM customer_client
    `);
    if (lignes.length === 0) return `${prefixe}requete reussie mais aucun compte client retourne (liste vide)`;
    return (
      prefixe +
      lignes
        .map((l) => {
          const cc = l.customer_client;
          return `${cc?.client_customer ?? "?"} "${cc?.descriptive_name ?? "?"}" statut=${cc?.status ?? "?"} gestionnaire=${cc?.manager ?? "?"} niveau=${cc?.level ?? "?"}`;
        })
        .join(" | ")
    );
  } catch (err) {
    return `${prefixe}echec de la requete sur le compte gestionnaire lui-meme : ${messageErreurGoogleAds(err)}`;
  }
}

/**
 * Construit un client Google Ads authentifie a partir de la connexion
 * Google active (meme principe que getGmailClient). Retourne null si Ads
 * n'est pas configure ou si aucune boite Google n'est connectee - jamais
 * d'erreur ici, c'est a l'appelant de decider comment reagir (Morgane
 * explique simplement que ce n'est pas encore configure).
 */
export async function obtenirClientAds(prisma: PrismaClient): Promise<Customer | null> {
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
    // Structure gestionnaire+client confirmee reelle (ATELIER BROCHANT
    // GESTION, 962-510-7482, gere Help-Services, 415-772-4879). Le long
    // blocage ("authorization_error":2) ne venait pas du routage mais de
    // l'absence d'acces utilisateur du compte connecte sur le compte
    // GESTIONNAIRE lui-meme (seul un acces sur le client avait ete
    // accorde) - voir journal des evenements google_ads_api_erreur pour
    // le detail du diagnostic. N'envoyer login_customer_id que s'il differe
    // du customer_id cible reste correct dans tous les cas.
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
      const premiere = e.errors[0] as {
        message?: unknown;
        error_code?: unknown;
        location?: { field_path_elements?: Array<{ field_name?: unknown; index?: unknown }> };
        details?: { policy_violation_details?: { external_policy_name?: unknown; external_policy_description?: unknown } };
      };
      if (typeof premiere?.message === "string" && premiere.message) {
        const code = premiere.error_code ? ` (${JSON.stringify(premiere.error_code)})` : "";
        // Le chemin exact du champ en cause (ex. "operations[2].create.keyword.match_type")
        // est indispensable pour diagnostiquer une erreur generique comme "REQUIRED" sans
        // deviner a l'aveugle lequel des nombreux appels mutate de creerCampagne est en cause.
        const chemin = (premiere.location?.field_path_elements ?? [])
          .map((el) => (el?.field_name ? `${String(el.field_name)}${el.index !== undefined ? `[${el.index}]` : ""}` : null))
          .filter((x): x is string => Boolean(x))
          .join(".");
        // Pour un rejet de politique de contenu (POLICY_ERROR), le message
        // generique ("A policy was violated") ne dit jamais QUELLE politique -
        // ces deux champs le disent explicitement (ex. "Trademarks in ad text").
        const politique = premiere.details?.policy_violation_details;
        const detailPolitique = politique?.external_policy_name
          ? ` [politique : ${String(politique.external_policy_name)}${politique.external_policy_description ? ` - ${String(politique.external_policy_description)}` : ""}]`
          : "";
        return `${premiere.message}${code}${chemin ? ` [champ : ${chemin}]` : ""}${detailPolitique}`;
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

/**
 * Change le statut (ENABLED/PAUSED) d'une campagne. N'est JAMAIS appelee
 * directement par Morgane : uniquement par googleAdsActions.ts, lors de
 * l'application d'une PropositionAds deja validee par l'utilisateur sur
 * l'ecran dedie - voir la discussion avec l'utilisateur (demande explicite
 * de ne jamais agir sans validation hors conversation).
 */
export async function changerStatutCampagne(prisma: PrismaClient, campagneId: string, nouveauStatut: "ENABLED" | "PAUSED"): Promise<void> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }

  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/-/g, "");
  await customer.campaigns.update([
    {
      resource_name: ResourceNames.campaign(customerId, campagneId),
      status: enums.CampaignStatus[nouveauStatut],
    },
  ]);
}

/**
 * Change le statut (ENABLED/PAUSED) d'un mot-cle PRECIS (par opposition a
 * changerStatutCampagne, qui agit sur la campagne entiere). groupeId et
 * criterionId identifient le mot-cle de facon unique (voir listerMotsCles) -
 * son texte seul ne suffit pas, le meme mot pouvant exister dans plusieurs
 * groupes d'annonces. JAMAIS appelee directement par Morgane : uniquement
 * par googleAdsActions.ts, lors de l'application d'une PropositionAds deja
 * validee par l'utilisateur sur l'ecran dedie.
 */
export async function changerStatutMotCle(prisma: PrismaClient, groupeId: string, criterionId: string, nouveauStatut: "ENABLED" | "PAUSED"): Promise<void> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }

  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/-/g, "");
  await customer.adGroupCriteria.update([
    {
      resource_name: ResourceNames.adGroupCriterion(customerId, groupeId, criterionId),
      status: enums.AdGroupCriterionStatus[nouveauStatut],
    },
  ]);
}

export interface CibleGeographiqueAds {
  nomRecherche: string; // le nom tel que fourni en entree (ex. "Seine-et-Marne")
  resourceName: string; // geoTargetConstants/<id>, a utiliser tel quel dans campaign_criterion.location
  nomTrouve: string;
  nomCanonique: string;
  typeCible: string; // ex. "Country", "State", "Department", "City"...
}

/**
 * Resout des noms de lieux (ex. "Île-de-France", "Seine-et-Marne") en
 * identifiants geographiques Google Ads (GeoTargetConstant), via le service
 * dedie plutot que des identifiants numeriques devines a la main (risque
 * reel de cibler le mauvais lieu). Prend le premier resultat retourne par
 * Google pour chaque nom - en pratique le plus pertinent, Google trie par
 * portee ("reach") decroissante. Un nom sans aucune correspondance est
 * absent du resultat plutot que de lever une erreur : a l'appelant de
 * decider si c'est bloquant.
 */
export async function rechercherCiblesGeographiques(prisma: PrismaClient, noms: string[]): Promise<CibleGeographiqueAds[]> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }
  if (noms.length === 0) return [];

  // Le type attendu par la librairie est la classe protobuf generee (avec
  // toJSON()), pas un objet simple comme pour les .create()/.update() qui
  // acceptent eux une interface "I*" en plus - ce service n'en expose pas.
  // Un objet simple au bon format fonctionne en pratique (protobuf.js
  // l'accepte a l'execution), d'ou le contournement de typage ci-dessous.
  const requete = { location_names: { names: noms }, locale: "fr", country_code: "FR" } as unknown as Parameters<
    Customer["geoTargetConstants"]["suggestGeoTargetConstants"]
  >[0];
  const reponse = await customer.geoTargetConstants.suggestGeoTargetConstants(requete);

  const parNom = new Map<string, CibleGeographiqueAds>();
  for (const suggestion of reponse.geo_target_constant_suggestions ?? []) {
    const cible = suggestion.geo_target_constant;
    const nomRecherche = suggestion.search_term ?? cible?.name ?? "";
    if (!cible?.resource_name || parNom.has(nomRecherche)) continue;
    parNom.set(nomRecherche, {
      nomRecherche,
      resourceName: cible.resource_name,
      nomTrouve: cible.name ?? "",
      nomCanonique: cible.canonical_name ?? "",
      typeCible: String(cible.target_type ?? ""),
    });
  }
  return [...parNom.values()];
}

export interface SitelinkAds {
  texte: string; // link_text, 1 a 25 caracteres
  description1?: string; // 1 a 35 caracteres ; si fourni, description2 doit l'etre aussi (et inversement)
  description2?: string;
  url?: string; // page de destination du sitelink ; si absente, reutilise l'URL finale de la campagne
}

export interface StructuredSnippetAds {
  header: string; // doit etre une des valeurs predefinies par Google (ex. "Services", "Types", "Marques")
  valeurs: string[]; // 3 a 10 valeurs, 1 a 25 caracteres chacune
}

export interface ExtensionsCampagne {
  sitelinks?: SitelinkAds[];
  callouts?: string[]; // 1 a 25 caracteres chacun
  structuredSnippets?: StructuredSnippetAds[];
}

function validerExtensions(extensions: ExtensionsCampagne) {
  for (const s of extensions.sitelinks ?? []) {
    if (!s.texte || s.texte.length > 25) throw new Error(`Sitelink invalide : "${s.texte}" (1 a 25 caracteres requis).`);
    if (Boolean(s.description1) !== Boolean(s.description2)) {
      throw new Error(`Sitelink "${s.texte}" : description1 et description2 doivent etre fournies ensemble, ou aucune des deux.`);
    }
  }
  for (const c of extensions.callouts ?? []) {
    if (!c || c.length > 25) throw new Error(`Accroche (callout) invalide : "${c}" (1 a 25 caracteres requis).`);
  }
  for (const s of extensions.structuredSnippets ?? []) {
    if (!s.header) throw new Error("Extrait structure : header manquant.");
    if (s.valeurs.length < 3 || s.valeurs.length > 10) throw new Error(`Extrait structure "${s.header}" : ${s.valeurs.length} valeur(s), il en faut entre 3 et 10.`);
  }
}

/**
 * Cree et lie des extensions d'annonce (liens d'accroche, accroches,
 * extraits structures) a une campagne. Usage interne, partage entre
 * creerCampagne (a la creation) et ajouterExtensionsCampagne (campagne
 * existante) - meme logique, seule la provenance du resource_name de
 * campagne change.
 */
async function creerEtLierExtensions(
  customer: Customer,
  campagneResourceName: string,
  urlParDefaut: string,
  extensions: ExtensionsCampagne
): Promise<void> {
  validerExtensions(extensions);
  const callouts = extensions.callouts ?? [];
  const structuredSnippets = extensions.structuredSnippets ?? [];
  const sitelinks = extensions.sitelinks ?? [];
  if (callouts.length === 0 && structuredSnippets.length === 0 && sitelinks.length === 0) return;

  const aCreer: Array<{ fieldType: number; payload: Record<string, unknown> }> = [
    ...callouts.map((texte) => ({ fieldType: enums.AssetFieldType.CALLOUT, payload: { callout_asset: { callout_text: texte } } })),
    ...structuredSnippets.map((s) => ({
      fieldType: enums.AssetFieldType.STRUCTURED_SNIPPET,
      payload: { structured_snippet_asset: { header: s.header, values: s.valeurs } },
    })),
    ...sitelinks.map((s) => ({
      fieldType: enums.AssetFieldType.SITELINK,
      payload: {
        final_urls: [s.url || urlParDefaut],
        sitelink_asset: {
          link_text: s.texte,
          ...(s.description1 ? { description1: s.description1, description2: s.description2 } : {}),
        },
      },
    })),
  ];

  const resultat = await customer.assets.create(aCreer.map((a) => a.payload));
  const resourceNames = resultat.results?.map((r) => r.resource_name) ?? [];
  if (resourceNames.length !== aCreer.length || resourceNames.some((rn) => !rn)) {
    throw new Error("Echec de la creation d'une ou plusieurs extensions (aucun resource_name retourne).");
  }

  await customer.campaignAssets.create(
    resourceNames.map((rn, i) => ({
      campaign: campagneResourceName,
      asset: rn!,
      field_type: aCreer[i].fieldType,
      status: enums.AssetLinkStatus.ENABLED,
    }))
  );
}

/**
 * Ajoute des extensions d'annonce a une campagne EXISTANTE. JAMAIS appelee
 * directement par Morgane : uniquement par googleAdsActions.ts, lors de
 * l'application d'une PropositionAds deja validee par l'utilisateur.
 */
export async function ajouterExtensionsCampagne(prisma: PrismaClient, campagneId: string, extensions: ExtensionsCampagne): Promise<void> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }
  if (!/^\d+$/.test(campagneId)) throw new Error(`campagneId invalide : "${campagneId}" (attendu : uniquement des chiffres).`);

  const lignes = await customer.query(`
    SELECT campaign.resource_name, campaign_budget.resource_name
    FROM campaign
    WHERE campaign.id = ${campagneId}
  `);
  const campagneResourceName = lignes[0]?.campaign?.resource_name;
  if (!campagneResourceName) throw new Error(`Campagne ${campagneId} introuvable.`);

  const ad = await customer.query(`
    SELECT ad_group_ad.ad.final_urls
    FROM ad_group_ad
    WHERE campaign.id = ${campagneId} AND ad_group_ad.status != 'REMOVED'
    LIMIT 1
  `);
  const urlParDefaut = ad[0]?.ad_group_ad?.ad?.final_urls?.[0] ?? "";

  await creerEtLierExtensions(customer, campagneResourceName, urlParDefaut, extensions);
}

export type StrategieEncheres = "MAXIMIZE_CONVERSIONS" | "TARGET_CPA" | "MANUAL_CPC";

export interface HoraireAds {
  jour: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY";
  heureDebut: number; // 0 a 23
  minuteDebut?: 0 | 15 | 30 | 45; // defaut 0 - Google n'accepte que ces 4 valeurs
  heureFin: number; // 1 a 24 (24 = minuit, fin de journee)
  minuteFin?: 0 | 15 | 30 | 45; // defaut 0
}

const MINUTE_VERS_ENUM: Record<number, number> = {
  0: enums.MinuteOfHour.ZERO,
  15: enums.MinuteOfHour.FIFTEEN,
  30: enums.MinuteOfHour.THIRTY,
  45: enums.MinuteOfHour.FORTY_FIVE,
};

function construireChampHoraire(h: HoraireAds): Record<string, unknown> {
  const minuteDebut = MINUTE_VERS_ENUM[h.minuteDebut ?? 0];
  const minuteFin = MINUTE_VERS_ENUM[h.minuteFin ?? 0];
  if (minuteDebut === undefined || minuteFin === undefined) {
    throw new Error(`Horaire invalide pour ${h.jour} : minutes acceptees uniquement 0, 15, 30 ou 45.`);
  }
  return {
    status: enums.CampaignCriterionStatus.ENABLED,
    ad_schedule: {
      day_of_week: enums.DayOfWeek[h.jour],
      start_hour: h.heureDebut,
      start_minute: minuteDebut,
      end_hour: h.heureFin,
      end_minute: minuteFin,
    },
  };
}

/**
 * Construit le champ d'enchere (oneof campaign_bidding_strategy) a appliquer
 * a la creation ou lors d'une modification. MAXIMIZE_CONVERSIONS par defaut
 * (deja le comportement historique). MANUAL_CPC active l'optimisation du
 * CPC (enhanced_cpc) plutot qu'un CPC totalement manuel, plus sur sans
 * gestion fine des encheres par mot-cle (non geree ici).
 */
function construireStrategieEncheres(strategie: StrategieEncheres | undefined, cpaCibleEuros: number | undefined): Record<string, unknown> {
  const s = strategie ?? "MAXIMIZE_CONVERSIONS";
  if (s === "TARGET_CPA") {
    if (!cpaCibleEuros || cpaCibleEuros <= 0) throw new Error("cpaCibleEuros doit etre un nombre positif pour la strategie TARGET_CPA.");
    return { target_cpa: { target_cpa_micros: toMicros(cpaCibleEuros) } };
  }
  if (s === "MANUAL_CPC") {
    return { manual_cpc: { enhanced_cpc_enabled: true } };
  }
  return { maximize_conversions: {} };
}

/**
 * Resout des noms de centres d'interet (ex. "Bricolage et jardinage",
 * "Proprietaires de maison") en criteres Google Ads (user_interest), via
 * une recherche textuelle GAQL plutot que des identifiants devines. Usage :
 * signal d'audience en OBSERVATION sur une campagne Search (n'exclut ni ne
 * restreint qui voit l'annonce - sert a ajuster les encheres et analyser la
 * performance par segment). Ce n'est PAS du remarketing (reciblage des
 * visiteurs du site) : cela necessiterait une balise de suivi sur le site,
 * absente aujourd'hui.
 */
export interface AudienceAds {
  nomRecherche: string;
  resourceName: string;
  nomTrouve: string;
}

export async function rechercherAudiences(prisma: PrismaClient, termes: string[]): Promise<AudienceAds[]> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }
  if (termes.length === 0) return [];

  const resultats: AudienceAds[] = [];
  for (const terme of termes) {
    const termeEchappe = terme.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const lignes = await customer.query(`
      SELECT user_interest.resource_name, user_interest.name
      FROM user_interest
      WHERE user_interest.name LIKE '%${termeEchappe}%'
      LIMIT 1
    `);
    const resourceName = lignes[0]?.user_interest?.resource_name;
    if (resourceName) {
      resultats.push({ nomRecherche: terme, resourceName, nomTrouve: lignes[0].user_interest?.name ?? "" });
    }
  }
  return resultats;
}

/** Ajoute des audiences (signal d'observation) a une campagne EXISTANTE. */
export async function ajouterAudiencesCampagne(prisma: PrismaClient, campagneId: string, audiences: string[]): Promise<void> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }
  if (!/^\d+$/.test(campagneId)) throw new Error(`campagneId invalide : "${campagneId}" (attendu : uniquement des chiffres).`);
  if (audiences.length === 0) return;

  const cibles = await rechercherAudiences(prisma, audiences);
  const manquantes = audiences.filter((nom) => !cibles.some((c) => c.nomRecherche === nom));
  if (manquantes.length > 0) {
    throw new Error(`Aucune correspondance Google pour les centres d'interet : "${manquantes.join('", "')}". Rien n'a ete ajoute.`);
  }

  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/-/g, "");
  await customer.campaignCriteria.create(
    cibles.map((c) => ({
      campaign: ResourceNames.campaign(customerId, campagneId),
      status: enums.CampaignCriterionStatus.ENABLED,
      user_interest: { user_interest_category: c.resourceName },
    }))
  );
}

/**
 * Change la strategie d'encheres d'une campagne EXISTANTE (par opposition
 * au choix fait a la creation dans creerCampagne).
 */
export async function changerStrategieEncheres(
  prisma: PrismaClient,
  campagneId: string,
  strategie: StrategieEncheres,
  cpaCibleEuros?: number
): Promise<void> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }
  if (!/^\d+$/.test(campagneId)) throw new Error(`campagneId invalide : "${campagneId}" (attendu : uniquement des chiffres).`);
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/-/g, "");

  await customer.campaigns.update([
    {
      resource_name: ResourceNames.campaign(customerId, campagneId),
      ...construireStrategieEncheres(strategie, cpaCibleEuros),
    },
  ]);
}

/** Ajoute des plages horaires de diffusion a une campagne EXISTANTE. */
export async function definirHorairesCampagne(prisma: PrismaClient, campagneId: string, horaires: HoraireAds[]): Promise<void> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }
  if (!/^\d+$/.test(campagneId)) throw new Error(`campagneId invalide : "${campagneId}" (attendu : uniquement des chiffres).`);
  if (horaires.length === 0) return;

  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/-/g, "");
  const campagneResourceName = ResourceNames.campaign(customerId, campagneId);
  await customer.campaignCriteria.create(horaires.map((h) => ({ campaign: campagneResourceName, ...construireChampHoraire(h) })));
}

/**
 * Ajoute une annonce supplementaire (variante de test A/B) a un groupe
 * d'annonces EXISTANT - creee EN PAUSE (meme principe de securite que
 * creerCampagne : rien ne diffuse avant activation manuelle). Permet de
 * comparer plusieurs versions d'annonces dans le meme groupe (voir
 * listerPerformanceAnnonces pour la comparaison).
 */
export async function ajouterAnnonceTest(prisma: PrismaClient, groupeId: string, titres: string[], descriptions: string[], urlFinale: string): Promise<void> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/-/g, "");
  await customer.adGroupAds.create([
    {
      ad_group: ResourceNames.adGroup(customerId, groupeId),
      status: enums.AdGroupAdStatus.PAUSED,
      ad: {
        final_urls: [urlFinale],
        responsive_search_ad: {
          headlines: titres.map((texte) => ({ text: texte })),
          descriptions: descriptions.map((texte) => ({ text: texte })),
        },
      },
    },
  ]);
}

export interface PerformanceAnnonceAds {
  groupeId: string;
  adId: string;
  titres: string[];
  descriptions: string[];
  statut: string;
  impressions: number;
  clics: number;
  cout: number;
  conversions: number;
  ctr: number;
}

/**
 * Performance par annonce individuelle au sein d'un groupe (par opposition
 * a listerCampagnesAds, agrege par campagne) - indispensable pour comparer
 * des variantes de test A/B creees via ajouterAnnonceTest. Lecture seule.
 */
export async function listerPerformanceAnnonces(prisma: PrismaClient, groupeId: string, jours = 30): Promise<PerformanceAnnonceAds[]> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure (jeton developpeur/numero de compte manquant) ou aucune boite Google connectee (se reconnecter via /auth/google).");
  }
  if (!/^\d+$/.test(groupeId)) throw new Error(`groupeId invalide : "${groupeId}" (attendu : uniquement des chiffres).`);

  const lignes = await customer.query(`
    SELECT
      ad_group.id,
      ad_group_ad.ad.id,
      ad_group_ad.ad.responsive_search_ad.headlines,
      ad_group_ad.ad.responsive_search_ad.descriptions,
      ad_group_ad.status,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.ctr
    FROM ad_group_ad
    WHERE ad_group.id = ${groupeId}
      AND segments.date ${clauseFenetreDate(jours)}
      AND ad_group_ad.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
  `);

  return lignes.map((ligne) => ({
    groupeId: String(ligne.ad_group?.id ?? ""),
    adId: String(ligne.ad_group_ad?.ad?.id ?? ""),
    titres: (ligne.ad_group_ad?.ad?.responsive_search_ad?.headlines ?? []).map((h) => h.text ?? ""),
    descriptions: (ligne.ad_group_ad?.ad?.responsive_search_ad?.descriptions ?? []).map((d) => d.text ?? ""),
    statut: String(ligne.ad_group_ad?.status ?? ""),
    impressions: Number(ligne.metrics?.impressions ?? 0),
    clics: Number(ligne.metrics?.clicks ?? 0),
    cout: fromMicros(Number(ligne.metrics?.cost_micros ?? 0)),
    conversions: Number(ligne.metrics?.conversions ?? 0),
    ctr: Number(ligne.metrics?.ctr ?? 0),
  }));
}

export interface ParametresCreationCampagne {
  nom: string;
  budgetQuotidien: number; // euros/jour
  urlFinale: string;
  titres: string[]; // 3 a 15 titres d'annonce
  descriptions: string[]; // 2 a 4 descriptions d'annonce
  motsCles: string[];
  motsClesExclus: string[];
  typeCorrespondance?: "EXACT" | "PHRASE" | "BROAD"; // defaut PHRASE - BROAD expose a trop de trafic non pertinent sans surveillance active
  ciblesGeographiques?: string[]; // noms de lieux a resoudre puis cibler (ex. "Île-de-France") - aucun = pas de restriction geographique
  numeroTelephone?: string; // si fourni, cree une extension d'appel liee des la creation (suivi d'appel compte-cible par defaut)
  sitelinks?: SitelinkAds[];
  callouts?: string[];
  structuredSnippets?: StructuredSnippetAds[];
  strategieEncheres?: StrategieEncheres; // defaut MAXIMIZE_CONVERSIONS
  cpaCibleEuros?: number; // requis si strategieEncheres = "TARGET_CPA"
  horaires?: HoraireAds[]; // aucun = diffusion sans restriction horaire
  audiences?: string[]; // noms de centres d'interet a resoudre puis attacher en observation
}

/**
 * Cree une campagne Search complete (budget, campagne, groupe d'annonces,
 * mots-cles, mots-cles exclus, annonce responsive) en un seul enchainement
 * d'appels. JAMAIS appelee directement par Morgane : uniquement par
 * googleAdsActions.ts, lors de l'application d'une PropositionAds deja
 * validee par l'utilisateur. La campagne est TOUJOURS creee en PAUSE
 * (status PAUSED) - demande explicite de l'utilisateur : aucune depense ne
 * commence avant qu'il ne l'active lui-meme dans Google Ads, apres
 * verification. Enchere automatique "maximiser les conversions" (pas
 * d'enchere manuelle par mot-cle a gerer).
 */
export async function creerCampagne(prisma: PrismaClient, params: ParametresCreationCampagne): Promise<{ campagneId: string }> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }

  const budgetResultat = await customer.campaignBudgets.create([
    {
      name: `${params.nom} - budget`,
      amount_micros: toMicros(params.budgetQuotidien),
      delivery_method: enums.BudgetDeliveryMethod.STANDARD,
      explicitly_shared: false,
    },
  ]);
  const budgetResourceName = budgetResultat.results?.[0]?.resource_name;
  if (!budgetResourceName) throw new Error("Echec de la creation du budget (aucun resource_name retourne).");

  const campagneResultat = await customer.campaigns.create([
    {
      name: params.nom,
      status: enums.CampaignStatus.PAUSED,
      advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
      campaign_budget: budgetResourceName,
      // Champ devenu obligatoire cote API (declaration UE sur la publicite
      // politique, reglementation europeenne) - echec reel observe sans lui
      // ("The required field was not present", champ
      // contains_eu_political_advertising). Les campagnes creees ici sont
      // toujours des campagnes commerciales locales (serrurerie...), jamais
      // de la publicite politique : valeur fixe, pas un choix a faire au cas
      // par cas.
      contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
      ...construireStrategieEncheres(params.strategieEncheres, params.cpaCibleEuros),
      network_settings: {
        target_google_search: true,
        target_search_network: true,
        target_content_network: false,
        target_partner_search_network: false,
      },
    },
  ]);
  const campagneResourceName = campagneResultat.results?.[0]?.resource_name;
  if (!campagneResourceName) throw new Error("Echec de la creation de la campagne (aucun resource_name retourne).");
  const campagneId = campagneResourceName.split("/").pop()!;

  const groupeResultat = await customer.adGroups.create([
    {
      name: `${params.nom} - groupe d'annonces`,
      campaign: campagneResourceName,
      status: enums.AdGroupStatus.ENABLED,
      type: enums.AdGroupType.SEARCH_STANDARD,
    },
  ]);
  const groupeResourceName = groupeResultat.results?.[0]?.resource_name;
  if (!groupeResourceName) throw new Error("Echec de la creation du groupe d'annonces (aucun resource_name retourne).");

  const typeCorrespondance = enums.KeywordMatchType[params.typeCorrespondance ?? "PHRASE"];
  if (params.motsCles.length > 0) {
    await customer.adGroupCriteria.create(
      params.motsCles.map((texte) => ({
        ad_group: groupeResourceName,
        status: enums.AdGroupCriterionStatus.ENABLED,
        keyword: { text: texte, match_type: typeCorrespondance },
      }))
    );
  }

  if (params.motsClesExclus.length > 0) {
    await ajouterMotsClesExclusCampagne(customer, campagneResourceName, params.motsClesExclus);
  }

  await customer.adGroupAds.create([
    {
      ad_group: groupeResourceName,
      status: enums.AdGroupAdStatus.ENABLED,
      ad: {
        final_urls: [params.urlFinale],
        responsive_search_ad: {
          headlines: params.titres.map((texte) => ({ text: texte })),
          descriptions: params.descriptions.map((texte) => ({ text: texte })),
        },
      },
    },
  ]);

  if (params.ciblesGeographiques && params.ciblesGeographiques.length > 0) {
    const cibles = await rechercherCiblesGeographiques(prisma, params.ciblesGeographiques);
    const manquants = params.ciblesGeographiques.filter((nom) => !cibles.some((c) => c.nomRecherche === nom));
    if (manquants.length > 0) {
      throw new Error(
        `Campagne creee (id ${campagneId}) mais ciblage geographique incomplet : aucune correspondance Google pour "${manquants.join('", "')}". Les autres lieux n'ont pas ete appliques non plus - corrige les noms et reessaie via une modification de ciblage.`
      );
    }
    await customer.campaignCriteria.create(
      cibles.map((cible) => ({
        campaign: campagneResourceName,
        status: enums.CampaignCriterionStatus.ENABLED,
        location: { geo_target_constant: cible.resourceName },
      }))
    );
  }

  if (params.numeroTelephone) {
    const assetResultat = await customer.assets.create([
      {
        type: enums.AssetType.CALL,
        call_asset: {
          country_code: "FR",
          phone_number: params.numeroTelephone,
          call_conversion_reporting_state: enums.CallConversionReportingState.USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION,
        },
      },
    ]);
    const assetResourceName = assetResultat.results?.[0]?.resource_name;
    if (!assetResourceName) {
      throw new Error(`Campagne creee (id ${campagneId}) mais echec de la creation de l'extension d'appel (aucun resource_name retourne).`);
    }
    await customer.campaignAssets.create([
      {
        campaign: campagneResourceName,
        asset: assetResourceName,
        field_type: enums.AssetFieldType.CALL,
        status: enums.AssetLinkStatus.ENABLED,
      },
    ]);
  }

  if (params.sitelinks?.length || params.callouts?.length || params.structuredSnippets?.length) {
    try {
      await creerEtLierExtensions(customer, campagneResourceName, params.urlFinale, {
        sitelinks: params.sitelinks,
        callouts: params.callouts,
        structuredSnippets: params.structuredSnippets,
      });
    } catch (err) {
      throw new Error(`Campagne creee (id ${campagneId}) mais echec de la creation des extensions (liens d'accroche/accroches/extraits) : ${messageErreurGoogleAds(err)}`);
    }
  }

  if (params.horaires && params.horaires.length > 0) {
    try {
      await customer.campaignCriteria.create(params.horaires.map((h) => ({ campaign: campagneResourceName, ...construireChampHoraire(h) })));
    } catch (err) {
      throw new Error(`Campagne creee (id ${campagneId}) mais echec de la configuration des horaires : ${messageErreurGoogleAds(err)}`);
    }
  }

  if (params.audiences && params.audiences.length > 0) {
    try {
      const cibles = await rechercherAudiences(prisma, params.audiences);
      const manquantes = params.audiences.filter((nom) => !cibles.some((c) => c.nomRecherche === nom));
      if (manquantes.length > 0) {
        throw new Error(`aucune correspondance Google pour "${manquantes.join('", "')}"`);
      }
      await customer.campaignCriteria.create(
        cibles.map((c) => ({
          campaign: campagneResourceName,
          status: enums.CampaignCriterionStatus.ENABLED,
          user_interest: { user_interest_category: c.resourceName },
        }))
      );
    } catch (err) {
      throw new Error(`Campagne creee (id ${campagneId}) mais echec de l'ajout des audiences : ${messageErreurGoogleAds(err)}`);
    }
  }

  return { campagneId };
}

/** Ajoute des mots-cles exclus (negatifs) au niveau de la campagne (correspondance large). Usage interne. */
async function ajouterMotsClesExclusCampagne(customer: Customer, campagneResourceName: string, motsClesExclus: string[]): Promise<void> {
  if (motsClesExclus.length === 0) return;
  await customer.campaignCriteria.create(
    motsClesExclus.map((texte) => ({
      campaign: campagneResourceName,
      status: enums.CampaignCriterionStatus.ENABLED,
      negative: true,
      keyword: { text: texte, match_type: enums.KeywordMatchType.BROAD },
    }))
  );
}

/**
 * Ajoute des mots-cles exclus a une campagne EXISTANTE (par opposition a
 * ceux definis a la creation dans creerCampagne). JAMAIS appelee
 * directement par Morgane : uniquement par googleAdsActions.ts, lors de
 * l'application d'une PropositionAds deja validee par l'utilisateur.
 */
export async function ajouterMotsClesExclus(prisma: PrismaClient, campagneId: string, motsClesExclus: string[]): Promise<void> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/-/g, "");
  await ajouterMotsClesExclusCampagne(customer, ResourceNames.campaign(customerId, campagneId), motsClesExclus);
}

/**
 * Change le budget quotidien d'une campagne EXISTANTE (par opposition au
 * budget initial fixe a la creation dans creerCampagne). JAMAIS appelee
 * directement par Morgane : uniquement par googleAdsActions.ts, lors de
 * l'application d'une PropositionAds deja validee par l'utilisateur sur
 * l'ecran dedie.
 */
export async function changerBudgetCampagne(prisma: PrismaClient, campagneId: string, nouveauBudgetQuotidien: number): Promise<void> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }
  if (!/^\d+$/.test(campagneId)) throw new Error(`campagneId invalide : "${campagneId}" (attendu : uniquement des chiffres).`);

  const lignes = await customer.query(`
    SELECT campaign_budget.resource_name
    FROM campaign
    WHERE campaign.id = ${campagneId}
  `);
  const budgetResourceName = lignes[0]?.campaign_budget?.resource_name;
  if (!budgetResourceName) throw new Error(`Aucun budget trouve pour la campagne ${campagneId}.`);

  await customer.campaignBudgets.update([
    {
      resource_name: budgetResourceName,
      amount_micros: toMicros(nouveauBudgetQuotidien),
    },
  ]);
}

/**
 * Ajoute des mots-cles POSITIFS a un groupe d'annonces EXISTANT (par
 * opposition aux mots-cles exclus de ajouterMotsClesExclus). groupeId
 * identifie le groupe d'annonces cible (voir listerMotsCles pour le
 * retrouver sur une campagne donnee). JAMAIS appelee directement par
 * Morgane : uniquement par googleAdsActions.ts, lors de l'application
 * d'une PropositionAds deja validee par l'utilisateur sur l'ecran dedie.
 */
export async function ajouterMotsClesPositifs(
  prisma: PrismaClient,
  groupeId: string,
  motsCles: string[],
  typeCorrespondance: "EXACT" | "PHRASE" | "BROAD" = "PHRASE"
): Promise<void> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }
  if (motsCles.length === 0) return;
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/-/g, "");
  await customer.adGroupCriteria.create(
    motsCles.map((texte) => ({
      ad_group: ResourceNames.adGroup(customerId, groupeId),
      status: enums.AdGroupCriterionStatus.ENABLED,
      keyword: { text: texte, match_type: enums.KeywordMatchType[typeCorrespondance] },
    }))
  );
}

function clauseCampagne(campagneId?: string): string {
  if (!campagneId) return "";
  if (!/^\d+$/.test(campagneId)) throw new Error(`campagneId invalide : "${campagneId}" (attendu : uniquement des chiffres).`);
  return ` AND campaign.id = ${campagneId}`;
}

export interface MotCleAds {
  campagneId: string;
  campagneNom: string;
  groupeId: string;
  groupeNom: string;
  criterionId: string;
  texte: string;
  typeCorrespondance: string;
  statut: string;
  scoreQualite: number | null;
  impressions: number;
  clics: number;
  cout: number;
  conversions: number;
  ctr: number;
  cpcMoyen: number;
}

/**
 * Performance par mot-cle (par opposition a listerCampagnesAds, agrege par
 * campagne). Primordial pour la gestion fine d'une campagne (section 3 de
 * la demande utilisateur) : identifier les mots-cles rentables a developper
 * et ceux a optimiser/exclure. `campagneId` optionnel pour se concentrer
 * sur une seule campagne (recommande des qu'on analyse une campagne
 * precise, pour limiter la taille de la reponse). N'inclut que les
 * mots-cles ayant eu au moins une impression sur la periode - un mot-cle
 * jamais diffuse n'apporte aucune information exploitable.
 */
export async function listerMotsCles(prisma: PrismaClient, jours = 30, campagneId?: string): Promise<MotCleAds[]> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure (jeton developpeur/numero de compte manquant) ou aucune boite Google connectee (se reconnecter via /auth/google).");
  }

  const lignes = await customer.query(`
    SELECT
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      ad_group_criterion.quality_info.quality_score,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.ctr,
      metrics.average_cpc
    FROM keyword_view
    WHERE segments.date ${clauseFenetreDate(jours)}
      AND ad_group_criterion.status != 'REMOVED'
      AND metrics.impressions > 0${clauseCampagne(campagneId)}
    ORDER BY metrics.cost_micros DESC
    LIMIT 300
  `);

  return lignes.map((ligne) => ({
    campagneId: String(ligne.campaign?.id ?? ""),
    campagneNom: ligne.campaign?.name ?? "",
    groupeId: String(ligne.ad_group?.id ?? ""),
    groupeNom: ligne.ad_group?.name ?? "",
    criterionId: String(ligne.ad_group_criterion?.criterion_id ?? ""),
    texte: ligne.ad_group_criterion?.keyword?.text ?? "",
    typeCorrespondance: String(ligne.ad_group_criterion?.keyword?.match_type ?? ""),
    statut: String(ligne.ad_group_criterion?.status ?? ""),
    scoreQualite: ligne.ad_group_criterion?.quality_info?.quality_score ?? null,
    impressions: Number(ligne.metrics?.impressions ?? 0),
    clics: Number(ligne.metrics?.clicks ?? 0),
    cout: fromMicros(Number(ligne.metrics?.cost_micros ?? 0)),
    conversions: Number(ligne.metrics?.conversions ?? 0),
    ctr: Number(ligne.metrics?.ctr ?? 0),
    cpcMoyen: fromMicros(Number(ligne.metrics?.average_cpc ?? 0)),
  }));
}

export interface TermeRechercheAds {
  campagneId: string;
  campagneNom: string;
  groupeNom: string;
  terme: string;
  statut: string; // "ADDED" (deja ajoute comme mot-cle) | "EXCLUDED" (deja exclu) | "ADDED_EXCLUDED" | "NONE"
  impressions: number;
  clics: number;
  cout: number;
  conversions: number;
  ctr: number;
  cpcMoyen: number;
}

/**
 * Termes de recherche REELS ayant declenche une annonce (par opposition
 * aux mots-cles cibles, qui sont une intention - le terme de recherche est
 * ce que l'internaute a effectivement tape). Primordial pour detecter le
 * trafic non pertinent et proposer des mots-cles exclus (section 4 de la
 * demande utilisateur). `statut` indique si ce terme est deja ajoute/exclu
 * comme mot-cle - inutile de proposer une exclusion sur un terme deja
 * EXCLUDED ou ADDED_EXCLUDED.
 */
export async function listerTermesRecherche(prisma: PrismaClient, jours = 30, campagneId?: string): Promise<TermeRechercheAds[]> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure (jeton developpeur/numero de compte manquant) ou aucune boite Google connectee (se reconnecter via /auth/google).");
  }

  const lignes = await customer.query(`
    SELECT
      campaign.id,
      campaign.name,
      ad_group.name,
      search_term_view.search_term,
      search_term_view.status,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.ctr,
      metrics.average_cpc
    FROM search_term_view
    WHERE segments.date ${clauseFenetreDate(jours)}
      AND metrics.impressions > 0${clauseCampagne(campagneId)}
    ORDER BY metrics.cost_micros DESC
    LIMIT 300
  `);

  return lignes.map((ligne) => ({
    campagneId: String(ligne.campaign?.id ?? ""),
    campagneNom: ligne.campaign?.name ?? "",
    groupeNom: ligne.ad_group?.name ?? "",
    terme: ligne.search_term_view?.search_term ?? "",
    statut: String(ligne.search_term_view?.status ?? ""),
    impressions: Number(ligne.metrics?.impressions ?? 0),
    clics: Number(ligne.metrics?.clicks ?? 0),
    cout: fromMicros(Number(ligne.metrics?.cost_micros ?? 0)),
    conversions: Number(ligne.metrics?.conversions ?? 0),
    ctr: Number(ligne.metrics?.ctr ?? 0),
    cpcMoyen: fromMicros(Number(ligne.metrics?.average_cpc ?? 0)),
  }));
}

// La librairie google-ads-api ne decode pas toujours un enum en texte
// lisible (constate a plusieurs reprises : call_conversion_reporting_state,
// puis conversion_action.type/category/status) - parfois elle renvoie deja
// le libellé ("ENABLED"), parfois le code numerique brut ("2"). Decode dans
// les deux cas via l'objet enum lui-meme (mapping inverse numero->libelle
// fourni par google-ads-api) plutot que de maintenir une table a la main.
function decoderEnum(enumObjet: Record<string, string | number>, valeur: unknown): string {
  const brut = String(valeur ?? "");
  if (brut === "" || Object.prototype.hasOwnProperty.call(enumObjet, brut)) return brut;
  const num = Number(brut);
  if (!Number.isNaN(num) && enumObjet[num] !== undefined) return String(enumObjet[num]);
  return brut;
}

export interface ActionConversionAds {
  id: string;
  nom: string;
  type: string;
  categorie: string;
  statut: string;
  comptePourObjectifPrincipal: boolean;
  dureeMinimaleAppel: number | null;
}

/**
 * Liste les actions de conversion CONFIGUREES au niveau du compte (par
 * opposition aux metriques metrics.conversions, qui ne sont que le resultat
 * de ces actions). Indispensable pour diagnostiquer un nombre de
 * conversions incoherent avec l'activite reelle - permet de voir
 * precisement CE QUI est compte comme conversion (type
 * PHONE_CALL_FROM_ADS/WEBSITE_CALL vs WEBSITE vs autre), et si une action
 * censee exister (ex. appel telephonique) est absente ou desactivee.
 * comptePourObjectifPrincipal = primary_for_goal : remplace depuis aout
 * 2022 l'ancien champ include_in_conversions_metric (devenu immuable cote
 * API, voir changerComptageActionConversion).
 */
export async function listerActionsConversion(prisma: PrismaClient): Promise<ActionConversionAds[]> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure (jeton developpeur/numero de compte manquant) ou aucune boite Google connectee (se reconnecter via /auth/google).");
  }

  const lignes = await customer.query(`
    SELECT
      conversion_action.id,
      conversion_action.name,
      conversion_action.type,
      conversion_action.category,
      conversion_action.status,
      conversion_action.primary_for_goal,
      conversion_action.phone_call_duration_seconds
    FROM conversion_action
    ORDER BY conversion_action.name
  `);

  return lignes.map((ligne) => ({
    id: String(ligne.conversion_action?.id ?? ""),
    nom: ligne.conversion_action?.name ?? "",
    type: decoderEnum(enums.ConversionActionType as unknown as Record<string, string | number>, ligne.conversion_action?.type),
    categorie: decoderEnum(enums.ConversionActionCategory as unknown as Record<string, string | number>, ligne.conversion_action?.category),
    statut: decoderEnum(enums.ConversionActionStatus as unknown as Record<string, string | number>, ligne.conversion_action?.status),
    comptePourObjectifPrincipal: Boolean(ligne.conversion_action?.primary_for_goal),
    dureeMinimaleAppel: ligne.conversion_action?.phone_call_duration_seconds ?? null,
  }));
}

/**
 * Change si une action de conversion compte dans l'objectif principal de
 * conversions (primary_for_goal). N'exclut PAS l'action ni ne supprime son
 * historique - elle continue d'apparaitre dans "Toutes les conversions",
 * seulement plus dans le chiffre principal utilise pour le CPA et les
 * encheres automatiques. Corrige une premiere version qui utilisait
 * include_in_conversions_metric, devenu en lecture seule cote API Google
 * Ads depuis aout 2022 (echec reel observe : "IMMUTABLE_FIELD"). JAMAIS
 * appelee directement par Morgane : uniquement par googleAdsActions.ts,
 * lors de l'application d'une PropositionAds deja validee par
 * l'utilisateur sur l'ecran dedie.
 */
export async function changerComptageActionConversion(prisma: PrismaClient, conversionActionId: string, inclure: boolean): Promise<void> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/-/g, "");
  await customer.conversionActions.update([
    {
      resource_name: ResourceNames.conversionAction(customerId, conversionActionId),
      primary_for_goal: inclure,
    },
  ]);
}

export interface ExtensionAppelAds {
  campagneId: string;
  campagneNom: string;
  statutLien: string;
  numero: string;
  indicatifPays: string;
  suiviConversionAppel: string; // "DISABLED" | "USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION" | "USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION"
}

// La librairie google-ads-api ne decode pas toujours en texte lisible les
// enums imbriques dans un message commun (ex. asset.call_asset.*, par
// opposition aux enums directement sur une ressource comme campaign.status) -
// constate en pratique : Morgane a recu "3" au lieu de
// "USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION", impossible a interpreter sans
// connaitre l'ordre de l'enum CallConversionReportingState. Decode
// explicitement plutot que de faire confiance a la conversion automatique.
const LIBELLES_SUIVI_CONVERSION_APPEL: Record<string, string> = {
  "0": "UNSPECIFIED",
  "1": "UNKNOWN",
  "2": "DISABLED",
  "3": "USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION",
  "4": "USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION",
};

/**
 * Liste les extensions d'appel (CallAsset) liees a chaque campagne, avec le
 * numero affiche et si le suivi de conversion d'appel y est active.
 * Indispensable pour verifier qu'une campagne dispose bien d'un moyen de
 * suivre les appels telephoniques independamment du site (demande
 * explicite de l'utilisateur) - une campagne absente de ce resultat n'a
 * PAS d'extension d'appel configuree. Lecture seule.
 */
export async function listerExtensionsAppel(prisma: PrismaClient, campagneId?: string): Promise<ExtensionAppelAds[]> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure (jeton developpeur/numero de compte manquant) ou aucune boite Google connectee (se reconnecter via /auth/google).");
  }

  const lignes = await customer.query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign_asset.status,
      asset.call_asset.phone_number,
      asset.call_asset.country_code,
      asset.call_asset.call_conversion_reporting_state
    FROM campaign_asset
    WHERE campaign_asset.field_type = 'CALL'
      AND campaign_asset.status != 'REMOVED'${clauseCampagne(campagneId)}
    ORDER BY campaign.name
  `);

  return lignes.map((ligne) => ({
    campagneId: String(ligne.campaign?.id ?? ""),
    campagneNom: ligne.campaign?.name ?? "",
    statutLien: String(ligne.campaign_asset?.status ?? ""),
    numero: ligne.asset?.call_asset?.phone_number ?? "",
    indicatifPays: ligne.asset?.call_asset?.country_code ?? "",
    suiviConversionAppel: (() => {
      const brut = String(ligne.asset?.call_asset?.call_conversion_reporting_state ?? "");
      return LIBELLES_SUIVI_CONVERSION_APPEL[brut] ?? brut;
    })(),
  }));
}

export type TypeActionConversionSite = "CLICK_TO_CALL" | "WEBPAGE";

/**
 * Cree une action de conversion WEB simple (clic sur le numero de
 * telephone, ou envoi d'un formulaire), standard et fiable - par
 * opposition au suivi d'appel avance (numero de suivi dynamique Google),
 * plus complexe et pas garanti sans verification au cas par cas. JAMAIS
 * appelee directement par Morgane : uniquement par googleAdsActions.ts,
 * lors de l'application d'une PropositionAds deja validee par
 * l'utilisateur. Categorie choisie automatiquement selon le type
 * (PHONE_CALL_LEAD pour un clic a appeler, SUBMIT_LEAD_FORM pour un
 * formulaire).
 */
export async function creerActionConversionSite(prisma: PrismaClient, nom: string, type: TypeActionConversionSite): Promise<{ id: string }> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure ou aucune boite Google connectee.");
  }

  const resultat = await customer.conversionActions.create([
    {
      name: nom,
      type: type === "CLICK_TO_CALL" ? enums.ConversionActionType.CLICK_TO_CALL : enums.ConversionActionType.WEBPAGE,
      category: type === "CLICK_TO_CALL" ? enums.ConversionActionCategory.PHONE_CALL_LEAD : enums.ConversionActionCategory.SUBMIT_LEAD_FORM,
      status: enums.ConversionActionStatus.ENABLED,
      counting_type: enums.ConversionActionCountingType.ONE_PER_CLICK,
    },
  ]);
  const resourceName = resultat.results?.[0]?.resource_name;
  if (!resourceName) throw new Error("Echec de la creation de l'action de conversion (aucun resource_name retourne).");

  return { id: resourceName.split("/").pop()! };
}

export interface SnippetConversionAds {
  globalSiteTag: string;
  eventSnippet: string;
}

/**
 * Recupere le code pret a coller (balise globale + extrait d'evenement)
 * pour une action de conversion donnee, fourni directement par Google Ads
 * (ConversionActionService) - evite de deviner ou de recopier un format a
 * la main. Lecture seule.
 */
export async function obtenirSnippetConversion(prisma: PrismaClient, conversionActionId: string): Promise<SnippetConversionAds[]> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure (jeton developpeur/numero de compte manquant) ou aucune boite Google connectee (se reconnecter via /auth/google).");
  }

  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/-/g, "");
  const lignes = await customer.query(`
    SELECT conversion_action.tag_snippets
    FROM conversion_action
    WHERE conversion_action.resource_name = '${ResourceNames.conversionAction(customerId, conversionActionId)}'
  `);

  const snippets = lignes[0]?.conversion_action?.tag_snippets ?? [];
  return snippets
    .filter((s) => s.global_site_tag && s.event_snippet)
    .map((s) => ({ globalSiteTag: s.global_site_tag!, eventSnippet: s.event_snippet! }));
}
