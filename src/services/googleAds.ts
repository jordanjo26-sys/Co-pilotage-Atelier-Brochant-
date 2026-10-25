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

export interface ParametresCreationCampagne {
  nom: string;
  budgetQuotidien: number; // euros/jour
  urlFinale: string;
  titres: string[]; // 3 a 15 titres d'annonce
  descriptions: string[]; // 2 a 4 descriptions d'annonce
  motsCles: string[];
  motsClesExclus: string[];
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
      maximize_conversions: {},
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

  if (params.motsCles.length > 0) {
    await customer.adGroupCriteria.create(
      params.motsCles.map((texte) => ({
        ad_group: groupeResourceName,
        status: enums.AdGroupCriterionStatus.ENABLED,
        keyword: { text: texte, match_type: enums.KeywordMatchType.BROAD },
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

export interface ActionConversionAds {
  nom: string;
  type: string;
  categorie: string;
  statut: string;
  comptabiliseeDansConversions: boolean;
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
 */
export async function listerActionsConversion(prisma: PrismaClient): Promise<ActionConversionAds[]> {
  const customer = await obtenirClientAds(prisma);
  if (!customer) {
    throw new Error("Google Ads non configure (jeton developpeur/numero de compte manquant) ou aucune boite Google connectee (se reconnecter via /auth/google).");
  }

  const lignes = await customer.query(`
    SELECT
      conversion_action.name,
      conversion_action.type,
      conversion_action.category,
      conversion_action.status,
      conversion_action.include_in_conversions_metric,
      conversion_action.phone_call_duration_seconds
    FROM conversion_action
    ORDER BY conversion_action.name
  `);

  return lignes.map((ligne) => ({
    nom: ligne.conversion_action?.name ?? "",
    type: String(ligne.conversion_action?.type ?? ""),
    categorie: String(ligne.conversion_action?.category ?? ""),
    statut: String(ligne.conversion_action?.status ?? ""),
    comptabiliseeDansConversions: Boolean(ligne.conversion_action?.include_in_conversions_metric),
    dureeMinimaleAppel: ligne.conversion_action?.phone_call_duration_seconds ?? null,
  }));
}
