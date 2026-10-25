/**
 * Audit technique de referencement (SEO classique + visibilite aupres des
 * robots IA - ChatGPT, Claude, Perplexity...) d'une page web. Demande
 * explicite de l'utilisateur : Morgane doit pouvoir analyser et conseiller
 * sur le referencement, mais n'a PAS acces au code du site lui-meme (herberge
 * sur une plateforme tierce, Emergent) - uniquement une analyse en lecture
 * seule de ce que la page expose publiquement, suivie de recommandations que
 * l'utilisateur transmet lui-meme a la plateforme qui gere le site (meme
 * principe que pour le code de suivi de conversion plus tot).
 *
 * Volontairement SANS navigateur (Playwright) : on lit le HTML brut tel
 * qu'un robot qui n'execute PAS JavaScript le recoit - c'est precisement ce
 * qui interesse ici, la plupart des robots IA (GPTBot, ClaudeBot,
 * PerplexityBot...) ne rendent pas le JavaScript, contrairement a Googlebot
 * qui le fait (avec des limites). Un site dont le contenu n'existe que via
 * JavaScript cote client peut donc etre bien classe sur Google mais
 * completement invisible pour un assistant IA.
 */

const USER_AGENTS_IA = ["GPTBot", "ChatGPT-User", "ClaudeBot", "anthropic-ai", "PerplexityBot", "Google-Extended", "CCBot", "Applebot-Extended"];

export interface FichierRacineAudit {
  existe: boolean; // true seulement si un VRAI fichier est servi (pas le HTML de secours d'une application monopage)
}

export interface AuditReferencementSite {
  url: string;
  codeStatut: number;
  tempsReponseMs: number;
  https: boolean;
  titre: string | null;
  longueurTitre: number | null;
  metaDescription: string | null;
  longueurMetaDescription: number | null;
  viewportMobile: boolean;
  canonical: string | null;
  nombreBlocsJsonLd: number; // donnees structurees (schema.org) - 0 = aucune
  longueurTexteVisibleSansJavascript: number;
  extraitTexteVisibleSansJavascript: string;
  renduCoteClientUniquement: boolean; // heuristique : tres peu de texte visible sans executer le JavaScript
  robotsTxt: FichierRacineAudit;
  sitemapXml: FichierRacineAudit;
  llmsTxt: FichierRacineAudit;
  robotsIaBloques: string[]; // noms des robots IA explicitement bloques dans robots.txt (vide si robots.txt absent ou aucun blocage)
}

/**
 * Verifie si un chemin racine (robots.txt, sitemap.xml, llms.txt) sert un
 * vrai fichier ou le HTML de secours d'une application monopage (SPA) qui
 * repond 200 a n'importe quelle URL. Distingue les deux via le debut du
 * contenu (une page HTML commence par <!doctype html> ou <html>).
 */
async function verifierFichierRacine(origine: string, chemin: string): Promise<{ audit: FichierRacineAudit; contenu: string | null }> {
  try {
    const reponse = await fetch(`${origine}/${chemin}`, { signal: AbortSignal.timeout(10_000) });
    const contenu = await reponse.text();
    const ressembleAUnePageHtml = /^\s*(<!doctype html|<html[\s>])/i.test(contenu);
    const existe = reponse.ok && !ressembleAUnePageHtml && contenu.trim().length > 0;
    return { audit: { existe }, contenu: existe ? contenu : null };
  } catch {
    return { audit: { existe: false }, contenu: null };
  }
}

function extraireBalise(html: string, regex: RegExp): string | null {
  const m = html.match(regex);
  return m ? m[1].trim() : null;
}

/** Robot IA bloque si robots.txt contient "User-agent: <nom>" suivi (avant le prochain "User-agent:") d'un "Disallow: /". */
function detecterRobotsIaBloques(robotsTxt: string): string[] {
  const bloques: string[] = [];
  for (const agent of USER_AGENTS_IA) {
    const regex = new RegExp(`user-agent:\\s*${agent}\\b[\\s\\S]*?(?=user-agent:|$)`, "i");
    const section = robotsTxt.match(regex)?.[0] ?? "";
    if (/disallow:\s*\/\s*$/im.test(section)) bloques.push(agent);
  }
  return bloques;
}

export async function auditerSiteWeb(url: string): Promise<AuditReferencementSite> {
  const origine = new URL(url).origin;
  const debut = Date.now();
  const reponse = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const tempsReponseMs = Date.now() - debut;
  const html = await reponse.text();

  const titre = extraireBalise(html, /<title[^>]*>([^<]*)<\/title>/i);
  const metaDescription = extraireBalise(html, /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
  const viewportMobile = /<meta[^>]*name=["']viewport["']/i.test(html);
  const canonical = extraireBalise(html, /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i);
  const nombreBlocsJsonLd = (html.match(/application\/ld\+json/gi) || []).length;

  let texteVisible = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const corpsMatch = texteVisible.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  texteVisible = (corpsMatch ? corpsMatch[1] : texteVisible)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const [robots, sitemap, llms] = await Promise.all([
    verifierFichierRacine(origine, "robots.txt"),
    verifierFichierRacine(origine, "sitemap.xml"),
    verifierFichierRacine(origine, "llms.txt"),
  ]);

  return {
    url,
    codeStatut: reponse.status,
    tempsReponseMs,
    https: url.startsWith("https://"),
    titre,
    longueurTitre: titre?.length ?? null,
    metaDescription,
    longueurMetaDescription: metaDescription?.length ?? null,
    viewportMobile,
    canonical,
    nombreBlocsJsonLd,
    longueurTexteVisibleSansJavascript: texteVisible.length,
    extraitTexteVisibleSansJavascript: texteVisible.slice(0, 300),
    renduCoteClientUniquement: texteVisible.length < 200,
    robotsTxt: robots.audit,
    sitemapXml: sitemap.audit,
    llmsTxt: llms.audit,
    robotsIaBloques: robots.contenu ? detecterRobotsIaBloques(robots.contenu) : [],
  };
}

const MOTS_APPEL_ACTION = [
  "appelez",
  "appeler",
  "contactez",
  "contacter",
  "devis",
  "intervention",
  "urgence",
  "demander",
  "reservez",
  "réservez",
  "nous contacter",
  "en savoir plus",
];

export interface AnalysePageDestination {
  url: string;
  codeStatut: number;
  tempsReponseMs: number;
  https: boolean;
  viewportMobile: boolean;
  renduCoteClientUniquement: boolean;
  telephonesCliquables: string[]; // numeros trouves dans des liens href="tel:...", vide si aucun
  formulaireDetecte: boolean;
  motsAppelActionTrouves: string[]; // parmi MOTS_APPEL_ACTION, ceux presents dans le texte visible de la page
}

/**
 * Analyse technique (lecture seule, sans navigateur) d'une page de
 * destination d'annonce - les signaux qu'une visite rapide peut verifier
 * objectivement AVANT de cliquer sur une annonce : la page repond vite, est
 * adaptee mobile, affiche un numero cliquable et un appel a l'action clair.
 * Ce n'est PAS une mesure de taux de conversion reel (ca demanderait les
 * donnees Google Ads/Analytics de la page, pas son HTML) - seulement des
 * signaux structurels qui, s'ils manquent, expliquent souvent un mauvais
 * taux de conversion malgre un bon trafic.
 */
export async function analyserPageDestination(url: string): Promise<AnalysePageDestination> {
  const debut = Date.now();
  const reponse = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const tempsReponseMs = Date.now() - debut;
  const html = await reponse.text();

  const viewportMobile = /<meta[^>]*name=["']viewport["']/i.test(html);

  let texteVisible = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const corpsMatch = texteVisible.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  texteVisible = (corpsMatch ? corpsMatch[1] : texteVisible)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const telephonesCliquables = [...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map((m) => m[1]);
  const formulaireDetecte = /<form[\s>]/i.test(html);
  const texteMinuscule = texteVisible.toLowerCase();
  const motsAppelActionTrouves = MOTS_APPEL_ACTION.filter((mot) => texteMinuscule.includes(mot));

  return {
    url,
    codeStatut: reponse.status,
    tempsReponseMs,
    https: url.startsWith("https://"),
    viewportMobile,
    renduCoteClientUniquement: texteVisible.length < 200,
    telephonesCliquables,
    formulaireDetecte,
    motsAppelActionTrouves,
  };
}
