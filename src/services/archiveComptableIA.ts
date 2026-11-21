import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";
import { logEvenement } from "./journalService";

/**
 * Extraction par IA des champs d'une facture pour le module Comptabilite
 * (archive de secours apres suppression des factures sur Dext par
 * l'ancien comptable, voir archiveComptable.ts). Memes principes que
 * gmailClassifyIA.ts :
 * - Ne devine jamais un champ absent ou illisible - le laisse vide plutot
 *   que d'inventer (section 14, "jamais deviner" : critique ici, ces
 *   donnees pouvant servir de preuve lors d'un controle fiscal).
 * - Toute panne (cle absente, erreur reseau, reponse invalide) retombe
 *   silencieusement sur "rien d'extrait" : le fichier reste simplement
 *   "a_verifier", jamais une erreur qui bloquerait l'import des centaines
 *   d'autres fichiers du meme lot.
 * - Pas de tool_choice force : regression reelle constatee en production
 *   (novembre 2026, voir gmailClassifyIA.ts) avec ce modele.
 */

const MODELE = "claude-sonnet-5-5";

/**
 * Categories comptables fixes - demande explicite de l'utilisateur ("classement
 * intelligent et actif"). A la difference de fournisseurNom/numero/dateFacture/
 * montants (des FAITS lus sur le document, jamais devines si absents), la
 * categorie est un CLASSEMENT : un jugement a partir du fournisseur et de la
 * nature de la facture, pas une donnee ecrite telle quelle sur le document.
 * L'IA doit donc toujours en proposer une (dont "Autre" en dernier recours)
 * plutot que de laisser le champ vide - toujours corrigeable a la main
 * ensuite (modifierArchiveComptable), jamais figee.
 */
export const CATEGORIES_FACTURE = [
  "Énergie",
  "Carburant",
  "Matériel et fournitures",
  "Location de matériel",
  "Sous-traitance",
  // Demande explicite de l'utilisateur (novembre 2026) : les factures de
  // sous-traitance en autoliquidation de la TVA (article 283-2 nonies du
  // CGI) doivent etre etiquetees distinctement de "Sous-traitance" - cote
  // comptable, le traitement de la TVA differe (TVA auto-liquidee par
  // l'utilisateur, jamais payee au sous-traitant). Voir
  // archiveComptable.ts : forcee automatiquement quand le document
  // mentionne explicitement une autoliquidation (gmailClassify.ts,
  // estAutoliquidation), jamais devinee par l'IA seule.
  "Auto liquidation",
  "Véhicule",
  "Assurance",
  "Télécommunications",
  "Banque et frais financiers",
  "Autre",
] as const;

export type CategorieFacture = (typeof CATEGORIES_FACTURE)[number];

export interface ChampsFacture {
  fournisseurNom?: string;
  numero?: string;
  dateFacture?: string; // AAAA-MM-JJ
  montantHT?: number;
  montantTTC?: number;
  categorie?: CategorieFacture;
}

const OUTIL_EXTRACTION: Anthropic.Tool = {
  name: "extraire_facture",
  description: "Enregistre les informations reellement lisibles sur ce document comptable.",
  input_schema: {
    type: "object",
    properties: {
      fournisseurNom: { type: "string", description: "Nom du fournisseur/de l'entreprise emettrice, tel qu'ecrit sur le document. Omis si illisible ou absent." },
      numero: { type: "string", description: "Numero de piece (facture/avoir), tel qu'ecrit. Omis si absent." },
      dateFacture: { type: "string", description: "Date du document au format AAAA-MM-JJ. Omise si illisible." },
      montantHT: { type: "number", description: "Montant HT en euros, tel qu'ecrit. Omis si illisible ou absent." },
      montantTTC: { type: "number", description: "Montant TTC en euros, tel qu'ecrit. Omis si illisible ou absent." },
      categorie: {
        type: "string",
        enum: [...CATEGORIES_FACTURE],
        description: "Categorie comptable la plus pertinente parmi la liste, deduite du fournisseur et de la nature de la facture. Utilise 'Autre' si aucune ne convient vraiment - a fournir systematiquement, contrairement aux autres champs.",
      },
    },
  },
};

const PROMPT_SYSTEME = `Tu lis un document comptable (facture, avoir, bon...) d'un artisan plombier francais \
pour en extraire les informations REELLEMENT visibles, en vue d'une archive consultee lors d'un \
controle fiscal.

Regle absolue : n'extrais QUE ce qui est effectivement lisible pour fournisseurNom/numero/dateFacture/ \
montantHT/montantTTC. Si une de ces informations est absente, illisible ou ambigue, omets-la purement \
et simplement - ne devine JAMAIS une valeur pour completer une reponse plus "utile". Une information \
omise n'a aucune consequence (l'utilisateur la completera a la main), alors qu'une valeur inventee \
presentee comme certaine serait une fausse preuve en cas de controle.

Pour le champ categorie en revanche, c'est different : ce n'est pas une donnee ecrite sur le document \
mais un classement, donc fournis-le TOUJOURS meme si tu dois deduire la categorie la plus probable a \
partir du nom du fournisseur et de la nature visible de l'achat (ex. EDF/Engie -> Energie, une station \
essence -> Carburant, Kiloutou -> Location de materiel). Utilise "Auto liquidation" uniquement si le \
document mentionne explicitement une autoliquidation de la TVA (ex. "TVA auto liquidation", \
"AUTOLIQUIDATION DE LA TVA", article 283-2 nonies du CGI) - jamais une simple facture de sous-traitance \
classique, qui reste "Sous-traitance". N'utilise "Autre" qu'en dernier recours, si vraiment aucune \
categorie ne correspond.

Appelle systematiquement l'outil extraire_facture avec ce que tu as reellement lu.`;

/**
 * prisma optionnel : uniquement pour journaliser une PANNE reelle (cle
 * invalide, erreur reseau, limite de debit...), jamais le cas normal "rien
 * d'extrait" (aucun bloc tool_use - le modele n'a simplement rien trouve
 * de lisible). Sans ce journal, une panne silencieuse etait indiscernable
 * d'un document genuinement illisible - vecu en novembre 2026, une facture
 * et un ticket papier reels sont restes "non renseigne" apres plusieurs
 * tentatives sans qu'aucune erreur ne soit jamais visible nulle part.
 */
async function appelerExtraction(client: Anthropic, contenu: Anthropic.MessageParam["content"], prisma?: PrismaClient): Promise<ChampsFacture | null> {
  try {
    const reponse = await client.messages.create({
      model: MODELE,
      max_tokens: 300,
      system: PROMPT_SYSTEME,
      tools: [OUTIL_EXTRACTION],
      messages: [{ role: "user", content: contenu }],
    });

    const appel = reponse.content.find((bloc): bloc is Anthropic.ToolUseBlock => bloc.type === "tool_use");
    if (!appel) return null;
    const entree = appel.input as ChampsFacture;
    const resultat: ChampsFacture = {};
    if (typeof entree.fournisseurNom === "string" && entree.fournisseurNom.trim()) resultat.fournisseurNom = entree.fournisseurNom.trim();
    if (typeof entree.numero === "string" && entree.numero.trim()) resultat.numero = entree.numero.trim();
    if (typeof entree.dateFacture === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entree.dateFacture)) resultat.dateFacture = entree.dateFacture;
    if (typeof entree.montantHT === "number" && entree.montantHT > 0) resultat.montantHT = entree.montantHT;
    if (typeof entree.montantTTC === "number" && entree.montantTTC > 0) resultat.montantTTC = entree.montantTTC;
    if (typeof entree.categorie === "string" && (CATEGORIES_FACTURE as readonly string[]).includes(entree.categorie)) {
      resultat.categorie = entree.categorie as CategorieFacture;
    }
    return Object.keys(resultat).length > 0 ? resultat : null;
  } catch (err) {
    if (prisma) {
      await logEvenement(prisma, {
        evenement: "extraction_ia_facture_echec",
        action: "Extraction IA des champs d'une facture",
        resultat: (err as Error).message,
      }).catch(() => {
        // Le journal lui-meme est indisponible : rien de plus a tenter,
        // l'appelant recoit deja "null" comme avant ce journal.
      });
    }
    return null;
  }
}

/** Extraction a partir du texte deja extrait d'un PDF (voir extractPdfText). */
export async function extraireChampsFacturePdf(texte: string, prisma?: PrismaClient): Promise<ChampsFacture | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const contenu = texte.trim().slice(0, 6000);
  if (!contenu) return null;
  const client = new Anthropic({ apiKey });
  return appelerExtraction(client, contenu, prisma);
}

const MIME_IMAGES_SUPPORTEES = new Set(["image/jpeg", "image/png"]);

/** Extraction par vision a partir d'une photo/scan (JPEG/PNG). */
export async function extraireChampsFactureImage(donnees: Buffer, mimeType: string, prisma?: PrismaClient): Promise<ChampsFacture | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const mime = mimeType.toLowerCase();
  if (!apiKey || !MIME_IMAGES_SUPPORTEES.has(mime)) return null;
  if (donnees.length > 15 * 1024 * 1024) return null;

  const client = new Anthropic({ apiKey });
  return appelerExtraction(
    client,
    [{ type: "image", source: { type: "base64", media_type: mime as "image/jpeg" | "image/png", data: donnees.toString("base64") } }],
    prisma
  );
}
