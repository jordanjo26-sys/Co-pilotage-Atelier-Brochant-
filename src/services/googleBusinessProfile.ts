import { PrismaClient } from "@prisma/client";
import { dechiffrer } from "./cipher";
import { buildOAuthClient } from "./googleAuth";

/**
 * Fiche Google Business Profile ("page Google Maps" dans les mots de
 * l'utilisateur) - demande explicite : avis clients, posts/actualites,
 * infos de la fiche (horaires, telephone...), statistiques.
 *
 * Phase 1 (ce fichier) : lecture seule, uniquement pour verifier que la
 * connexion fonctionne reellement - aucune capacite de reponse aux avis,
 * de publication ou de modification pour l'instant (viendra une fois la
 * lecture confirmee, meme demarche que Google Ads : phase 1 lecture,
 * phase 2 actions via une proposition validee par l'utilisateur, jamais
 * une execution immediate depuis la conversation).
 *
 * Reutilise la connexion Google deja etablie pour Gmail/Calendar/Ads (scope
 * "business.manage" ajoute a GMAIL_SCOPES dans googleAuth.ts) : pas de
 * deuxieme ecran de connexion a gerer, juste une reconnexion via
 * /auth/google pour accorder le nouveau scope.
 *
 * IMPORTANT (jamais deviner, confirme explicitement par l'utilisateur) :
 * deux conditions INDEPENDANTES du scope doivent etre reunies avant que les
 * appels ci-dessous reussissent, sinon Google repond 403/PERMISSION_DENIED
 * meme avec un jeton valide portant le bon scope :
 *   1. L'API Business Profile n'est pas en libre-service (contrairement a
 *      Ads/Gmail) : il faut que Google ait approuve une demande d'acces
 *      ("Application for Basic API Access",
 *      developers.google.com/my-business/content/basic-setup) pour le
 *      projet Google Cloud utilise ici - delai annonce ~14 jours.
 *   2. Le compte connecte (atelier.brochant@gmail.com) doit avoir ete
 *      ajoute comme gestionnaire/proprietaire DIRECTEMENT SUR LA FICHE,
 *      depuis l'interface Google Business Profile (business.google.com) -
 *      la fiche existante de l'utilisateur n'y est pas rattachee a ce jour.
 */

const COMPTES_URL = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";

export interface CompteBusinessProfile {
  nom: string; // ex. "accounts/123456789"
  nomAffiche: string | null;
  type: string | null;
}

export interface FicheBusinessProfile {
  nom: string; // ex. "accounts/123456789/locations/987654321"
  titre: string | null;
}

export class GoogleBusinessProfileError extends Error {}

function businessProfileEstConfigure(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

async function obtenirJetonAcces(prisma: PrismaClient): Promise<string> {
  if (!businessProfileEstConfigure()) {
    throw new GoogleBusinessProfileError("Connexion Google non configuree (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET absents).");
  }
  const connexion = await prisma.gmailConnexion.findFirst({ where: { actif: true } });
  if (!connexion) {
    throw new GoogleBusinessProfileError("Aucune connexion Google active. Se connecter via /auth/google.");
  }
  const client = buildOAuthClient();
  client.setCredentials({ refresh_token: dechiffrer(connexion.refreshTokenChiffre) });
  const { token } = await client.getAccessToken();
  if (!token) throw new GoogleBusinessProfileError("Impossible d'obtenir un jeton d'acces Google.");
  return token;
}

/**
 * Liste les comptes Business Profile visibles par le compte Google
 * connecte - le tout premier appel qui confirme (ou infirme) que les deux
 * conditions ci-dessus sont reunies. Erreur explicite sinon, jamais de
 * resultat invente.
 */
export async function listerComptesBusinessProfile(prisma: PrismaClient): Promise<CompteBusinessProfile[]> {
  const jeton = await obtenirJetonAcces(prisma);
  const reponse = await fetch(COMPTES_URL, { headers: { Authorization: `Bearer ${jeton}` } });
  const corps = (await reponse.json().catch(() => ({}))) as {
    accounts?: { name: string; accountName?: string; type?: string }[];
    error?: { message?: string; status?: string };
  };
  if (!reponse.ok) {
    throw new GoogleBusinessProfileError(
      `Echec de la lecture des comptes Business Profile (${reponse.status}${corps.error?.status ? ` ${corps.error.status}` : ""}) : ${corps.error?.message || "erreur inconnue"}`
    );
  }
  return (corps.accounts || []).map((c) => ({ nom: c.name, nomAffiche: c.accountName ?? null, type: c.type ?? null }));
}

/** Liste les fiches (etablissements) d'un compte Business Profile donne. */
export async function listerFichesBusinessProfile(prisma: PrismaClient, compteNom: string): Promise<FicheBusinessProfile[]> {
  const jeton = await obtenirJetonAcces(prisma);
  const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${compteNom}/locations?readMask=name,title`;
  const reponse = await fetch(url, { headers: { Authorization: `Bearer ${jeton}` } });
  const corps = (await reponse.json().catch(() => ({}))) as {
    locations?: { name: string; title?: string }[];
    error?: { message?: string; status?: string };
  };
  if (!reponse.ok) {
    throw new GoogleBusinessProfileError(
      `Echec de la lecture des fiches (${reponse.status}${corps.error?.status ? ` ${corps.error.status}` : ""}) : ${corps.error?.message || "erreur inconnue"}`
    );
  }
  return (corps.locations || []).map((l) => ({ nom: l.name, titre: l.title ?? null }));
}
