import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { logEvenement } from "./journalService";
import { enregistrerArchiveComptableExterne } from "./archiveComptable";

/**
 * Connexion directe a l'API officielle OVHcloud (demande explicite de
 * l'utilisateur : recuperer automatiquement les factures de fournisseurs
 * recurrents qui n'arrivent jamais par e-mail/Dext, OVHcloud en tete).
 * Contrairement a EDF/Bouygues Telecom (aucune API en libre-service pour un
 * compte pro standard, verifie avant de commencer ce travail), OVHcloud en
 * expose une reellement self-service : cle generee par l'utilisateur
 * lui-meme sur une page OVH officielle (createToken), jamais un mot de
 * passe du site - meme principe de moindre privilege que Stripe/Synec (voir
 * docs/mise-en-service.md).
 *
 * Etape 1 (ce fichier, pour l'instant) : authentification + un point de
 * diagnostic en lecture seule qui renvoie la reponse BRUTE de l'API pour
 * une poignee de factures recentes. Volontairement separe de toute creation
 * d'ArchiveComptable : la doc publique sur la forme exacte de l'objet
 * "facture" renvoye par /me/bill/{billId} est incertaine/non garantie (champs
 * en camelCase vs objets {value, text}, selon les sources trouvees) - plutot
 * que de deviner cette forme et risquer d'enregistrer un montant au mauvais
 * endroit (donc invisible), on verifie d'abord la vraie reponse une fois la
 * connexion etablie, puis on cablera la creation d'archives sur cette base
 * reelle (section 14, "jamais deviner").
 */

const ENDPOINTS: Record<string, string> = {
  "ovh-eu": "eu.api.ovh.com",
  "ovh-us": "api.us.ovhcloud.com",
  "ovh-ca": "ca.api.ovh.com",
};

function hote(): string {
  const zone = process.env.OVH_ENDPOINT || "ovh-eu";
  const hote = ENDPOINTS[zone];
  if (!hote) throw new Error(`OVH_ENDPOINT invalide : "${zone}" (attendu : ${Object.keys(ENDPOINTS).join(", ")}).`);
  return hote;
}

export function ovhEstConfigure(): boolean {
  return Boolean(process.env.OVH_APPLICATION_KEY && process.env.OVH_APPLICATION_SECRET && process.env.OVH_CONSUMER_KEY);
}

interface IdentifiantsOvh {
  applicationKey: string;
  applicationSecret: string;
  consumerKey: string;
}

function identifiants(): IdentifiantsOvh {
  const applicationKey = process.env.OVH_APPLICATION_KEY;
  const applicationSecret = process.env.OVH_APPLICATION_SECRET;
  const consumerKey = process.env.OVH_CONSUMER_KEY;
  if (!applicationKey || !applicationSecret || !consumerKey) {
    throw new Error("OVH non configure (OVH_APPLICATION_KEY/OVH_APPLICATION_SECRET/OVH_CONSUMER_KEY manquant(s)).");
  }
  return { applicationKey, applicationSecret, consumerKey };
}

// L'API OVH signe chaque requete a partir d'un horodatage - un decalage
// d'horloge entre ce serveur et OVH (meme de quelques secondes) fait
// rejeter la signature ("Invalid timestamp"), d'ou cette synchronisation
// via leur propre endpoint public (non authentifie) avant le premier
// appel reel, plutot que de supposer l'horloge du serveur fiable.
let decalageHorlogeMs: number | null = null;

async function decalageHorloge(): Promise<number> {
  if (decalageHorlogeMs != null) return decalageHorlogeMs;
  const reponse = await fetch(`https://${hote()}/1.0/auth/time`);
  if (!reponse.ok) throw new Error(`OVH /auth/time : HTTP ${reponse.status}`);
  const tempsServeurUnix = Number(await reponse.text());
  decalageHorlogeMs = tempsServeurUnix * 1000 - Date.now();
  return decalageHorlogeMs;
}

/**
 * Appel authentifie generique a l'API OVH (v1 "signature a cle", le seul
 * flux compatible avec une cle generee via createToken - pas le flux OAuth2
 * plus recent, reserve aux applications multi-clients). Retourne le JSON
 * brut tel que renvoye par OVH : aucun champ n'est suppose/renomme ici.
 */
async function appelOvh<T>(method: "GET" | "POST", chemin: string): Promise<T> {
  const { applicationKey, applicationSecret, consumerKey } = identifiants();
  const decalage = await decalageHorloge();
  const timestamp = Math.round((Date.now() + decalage) / 1000);
  const url = `https://${hote()}/1.0${chemin}`;
  const corps = "";
  const signature =
    "$1$" +
    crypto
      .createHash("sha1")
      .update(`${applicationSecret}+${consumerKey}+${method}+${url}+${corps}+${timestamp}`)
      .digest("hex");

  const reponse = await fetch(url, {
    method,
    headers: {
      "X-Ovh-Application": applicationKey,
      "X-Ovh-Consumer": consumerKey,
      "X-Ovh-Timestamp": String(timestamp),
      "X-Ovh-Signature": signature,
      "Content-Type": "application/json",
    },
  });
  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => "");
    throw new Error(`OVH ${method} ${chemin} : HTTP ${reponse.status}${detail ? ` - ${detail}` : ""}`);
  }
  return (await reponse.json()) as T;
}

export async function verifierConnexionOvh(): Promise<{ ok: true; compte: unknown } | { ok: false; motif: string }> {
  if (!ovhEstConfigure()) return { ok: false, motif: "OVH non configure (OVH_APPLICATION_KEY/OVH_APPLICATION_SECRET/OVH_CONSUMER_KEY)." };
  try {
    const compte = await appelOvh<unknown>("GET", "/me");
    return { ok: true, compte };
  } catch (err) {
    return { ok: false, motif: (err as Error).message };
  }
}

/**
 * Diagnostic en lecture seule : liste des identifiants de factures
 * recentes puis le detail BRUT (non retraite) des `limite` premieres -
 * sert uniquement a verifier, sur le vrai compte OVH de l'utilisateur, la
 * forme exacte des champs avant d'ecrire la logique de creation
 * d'ArchiveComptable dessus (voir l'en-tete de ce fichier).
 */
export async function obtenirFacturesBrutesOvh(limite = 3): Promise<{ identifiants: string[]; details: unknown[] }> {
  const idsFactures = await appelOvh<string[]>("GET", "/me/bill");
  const details = await Promise.all(idsFactures.slice(0, limite).map((id) => appelOvh<unknown>("GET", `/me/bill/${encodeURIComponent(id)}`)));
  return { identifiants: idsFactures, details };
}

// Forme reelle confirmee sur le compte de l'utilisateur (voir obtenirFacturesBrutesOvh,
// appele avant d'ecrire ce qui suit - jamais devinee) : prix en objets
// {value, text, currencyCode}, pas des nombres bruts.
interface MontantOvh {
  value: number;
  text: string;
  currencyCode: string;
}

interface FactureOvh {
  billId: string;
  date: string; // ISO 8601 avec fuseau, ex. "2016-10-01T19:21:42+02:00"
  pdfUrl: string;
  priceWithTax: MontantOvh;
  priceWithoutTax: MontantOvh;
}

const NOM_FOURNISSEUR_OVH = "OVHcloud";

export interface ResultatSyncOvh {
  facturesExaminees: number;
  facturesNouvelles: number;
  erreurs: string[];
}

/**
 * Synchronise les factures OVHcloud (demande explicite de l'utilisateur :
 * seulement les NOUVELLES factures a partir de maintenant, jamais
 * l'historique complet du compte - des 2016 dans ce cas reel - qu'il gere
 * deja par ailleurs). Meme principe de watermark que derniereSynchroStripe :
 * le journal d'evenements ("ovh_sync") sert de reference, sans etat
 * supplementaire a maintenir. Idempotent par construction (dedoublonnage
 * par numero+fournisseurNom avant toute creation), donc sans risque a
 * rejouer.
 */
export async function synchroniserOvh(prisma: PrismaClient): Promise<ResultatSyncOvh> {
  const resultat: ResultatSyncOvh = { facturesExaminees: 0, facturesNouvelles: 0, erreurs: [] };

  // Premiere synchronisation : aucune trace anterieure dans le journal ->
  // le repere (watermark) est fixe a MAINTENANT, pas au debut du compte -
  // demande explicite de l'utilisateur ("pas de raison d'importer, hormis
  // les nouvelles factures").
  const depuis = (await derniereSynchroOvh(prisma)) ?? new Date();

  const idsFactures = await appelOvh<string[]>("GET", "/me/bill");

  for (const billId of idsFactures) {
    try {
      const dejaPresente = await prisma.archiveComptable.findFirst({
        where: { fournisseurNom: NOM_FOURNISSEUR_OVH, numero: billId },
        select: { id: true },
      });
      if (dejaPresente) continue; // deja importee (re-execution ulterieure) - jamais retraitee

      const detail = await appelOvh<FactureOvh>("GET", `/me/bill/${encodeURIComponent(billId)}`);
      const dateFacture = new Date(detail.date);
      if (dateFacture < depuis) continue; // anterieure au repere - jamais importee (voir ci-dessus)

      resultat.facturesExaminees++;

      const reponsePdf = await fetch(detail.pdfUrl);
      if (!reponsePdf.ok) throw new Error(`Telechargement du PDF (HTTP ${reponsePdf.status}).`);
      const donnees = Buffer.from(await reponsePdf.arrayBuffer());

      await enregistrerArchiveComptableExterne(prisma, {
        fichierNom: `${NOM_FOURNISSEUR_OVH} - ${dateFacture.toISOString().slice(0, 10)} - ${billId}.pdf`,
        donnees,
        mimeType: "application/pdf",
        fournisseurNom: NOM_FOURNISSEUR_OVH,
        numero: billId,
        dateFacture,
        montantHT: detail.priceWithoutTax.value,
        montantTTC: detail.priceWithTax.value,
        classifiePar: "ovh_api",
      });
      resultat.facturesNouvelles++;
    } catch (err) {
      resultat.erreurs.push(`Facture ${billId} : ${(err as Error).message}`);
    }
  }

  await logEvenement(prisma, {
    evenement: "ovh_sync",
    action: "Synchronisation des factures OVHcloud",
    resultat: `${resultat.facturesNouvelles} facture(s) nouvelle(s) sur ${resultat.facturesExaminees} examinee(s), ${resultat.erreurs.length} erreur(s).`,
  });

  return resultat;
}

/** Date de la derniere synchronisation reussie, pour affichage et comme repere (watermark) de synchroniserOvh. */
export async function derniereSynchroOvh(prisma: PrismaClient): Promise<Date | null> {
  const dernier = await prisma.journalEvenement.findFirst({
    where: { evenement: "ovh_sync" },
    orderBy: { horodatage: "desc" },
  });
  return dernier?.horodatage || null;
}
