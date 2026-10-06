import { promises as dns } from "node:dns";
import { PrismaClient } from "@prisma/client";

/**
 * Module d'enrichissement email (section 2.3 du cahier des charges
 * prospection) : pour un prospect sans email connu mais dont le nom de
 * domaine est disponible (site web), propose une adresse professionnelle
 * plausible et verifie sa fiabilite avant tout envoi.
 *
 * Deux niveaux, dans l'esprit de prudence du reste de l'application (ne
 * jamais inventer une donnee non verifiable, section 14) :
 *  1. Verification MX du domaine (aucune cle API necessaire) : confirme
 *     que le domaine accepte des emails du tout, condition necessaire mais
 *     pas suffisante (ne garantit pas qu'une boite precise existe).
 *  2. Un fournisseur tiers d'enrichissement (Hunter.io, Dropcontact -
 *     section 4) verifie l'existence de la boite elle-meme. Non branche
 *     par defaut (aucune cle retenue - point 7 a arbitrer avec le
 *     developpeur) : voir enrichirViaHunter(), deja structuree pour ca.
 */

function extraireDomaine(siteWeb: string): string | null {
  try {
    const url = siteWeb.startsWith("http") ? siteWeb : `https://${siteWeb}`;
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Le domaine a-t-il un serveur de messagerie ? Verification reelle, sans cle API. */
export async function domaineAcceptesEmails(domaine: string): Promise<boolean> {
  try {
    const records = await dns.resolveMx(domaine);
    return records.length > 0;
  } catch {
    return false;
  }
}

function slugifier(valeur: string): string {
  return valeur
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export interface CandidatEmail {
  email: string;
  score: number; // 0-100
}

/**
 * Genere des adresses candidates a partir du nom de domaine et, si connu,
 * du nom du contact. Classees par plausibilite decroissante (un email
 * generique type "contact@" est plus souvent surveille qu'invente, un email
 * nominatif est plus fiable s'il existe vraiment - d'ou le score, affine
 * ensuite par la verification MX).
 */
export function genererCandidatsEmail(domaine: string, contactNom?: string | null): CandidatEmail[] {
  const candidats: CandidatEmail[] = [];

  if (contactNom?.trim()) {
    const parties = contactNom.trim().split(/\s+/).map(slugifier).filter(Boolean);
    if (parties.length >= 2) {
      const [prenom, ...reste] = parties;
      const nom = reste.join("");
      candidats.push({ email: `${prenom}.${nom}@${domaine}`, score: 55 });
      candidats.push({ email: `${prenom[0]}${nom}@${domaine}`, score: 40 });
    }
  }

  candidats.push({ email: `contact@${domaine}`, score: 35 });
  candidats.push({ email: `info@${domaine}`, score: 25 });

  return candidats;
}

export interface EnrichissementResultat {
  email: string | null;
  score: number | null;
  source: string | null;
}

/**
 * Enrichit un prospect : genere les candidats a partir de son site web,
 * garde le premier dont le domaine accepte des emails, avec un score
 * plafonne a 60 (une verification MX ne confirme jamais l'existence d'une
 * boite precise - seul un fournisseur tiers comme Hunter.io le ferait).
 * Ne modifie rien si le prospect a deja un email ou n'a pas de site web.
 */
export async function enrichirProspect(prisma: PrismaClient, prospectId: string): Promise<EnrichissementResultat> {
  const prospect = await prisma.prospect.findUniqueOrThrow({ where: { id: prospectId } });

  if (prospect.email) {
    return { email: prospect.email, score: prospect.emailScoreFiabilite, source: prospect.emailSource };
  }
  if (!prospect.siteWeb) {
    return { email: null, score: null, source: null };
  }

  const domaine = extraireDomaine(prospect.siteWeb);
  if (!domaine) {
    return { email: null, score: null, source: null };
  }

  const hunterResultat = await enrichirViaHunter(domaine, prospect.contactNom);
  if (hunterResultat) {
    await prisma.prospect.update({
      where: { id: prospectId },
      data: { email: hunterResultat.email, emailScoreFiabilite: hunterResultat.score, emailSource: "enrichissement_hunter" },
    });
    return { ...hunterResultat, source: "enrichissement_hunter" };
  }

  const accepteEmails = await domaineAcceptesEmails(domaine);
  if (!accepteEmails) {
    return { email: null, score: null, source: null };
  }

  const [candidat] = genererCandidatsEmail(domaine, prospect.contactNom);
  const score = Math.min(candidat.score + 25, 60);

  await prisma.prospect.update({
    where: { id: prospectId },
    data: { email: candidat.email, emailScoreFiabilite: score, emailSource: "enrichissement_pattern" },
  });

  return { email: candidat.email, score, source: "enrichissement_pattern" };
}

/**
 * Verification anti-rebond avant tout envoi (section 2.3 : "verification
 * anti-rebond avant tout envoi"). Reste sur la verification MX en l'absence
 * de fournisseur tiers : suffisant pour ecarter un domaine manifestement
 * invalide, pas pour garantir l'existence de la boite.
 */
export async function verifierAntiRebond(email: string): Promise<boolean> {
  const domaine = email.split("@")[1];
  if (!domaine) return false;
  return domaineAcceptesEmails(domaine);
}

/**
 * Fournisseur tiers d'enrichissement (Hunter.io - section 4). Non branche
 * par defaut : HUNTER_API_KEY absente en l'absence d'abonnement retenu
 * (point 7). Une fois une cle fournie, ce point d'entree est deja
 * cablable depuis enrichirProspect() ci-dessus sans autre changement.
 */
async function enrichirViaHunter(domaine: string, contactNom?: string | null): Promise<CandidatEmail | null> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return null;

  const params = new URLSearchParams({ domain: domaine, api_key: apiKey });
  if (contactNom?.trim()) {
    const parties = contactNom.trim().split(/\s+/);
    if (parties.length >= 2) {
      params.set("first_name", parties[0]);
      params.set("last_name", parties.slice(1).join(" "));
    }
  }

  const endpoint = contactNom?.trim() ? "email-finder" : "domain-search";
  const response = await fetch(`https://api.hunter.io/v2/${endpoint}?${params.toString()}`);
  if (!response.ok) return null;

  const data = (await response.json()) as { data?: { email?: string; score?: number; emails?: { value: string; confidence: number }[] } };
  if (data.data?.email) {
    return { email: data.data.email, score: data.data.score ?? 50 };
  }
  const premier = data.data?.emails?.[0];
  return premier ? { email: premier.value, score: premier.confidence } : null;
}
