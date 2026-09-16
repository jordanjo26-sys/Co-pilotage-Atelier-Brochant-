import Anthropic from "@anthropic-ai/sdk";
import { TypeDocument } from "./gmailClassify";

/**
 * Filet de securite par IA pour la classification des documents recus par
 * e-mail (demande explicite de l'utilisateur, apres deux regressions
 * reelles sur la regle "avoir" : les mots-cles seuls ne suffisent pas
 * toujours a distinguer une facture d'un autre type, notamment quand le
 * mot-cle attendu est absent ou ambigu dans son usage).
 *
 * Design volontairement conservateur, dans le prolongement direct de la
 * section 14 ("jamais deviner") plutot qu'en rupture avec elle :
 * - N'INTERVIENT JAMAIS a la place des regles deterministes
 *   (gmailClassify.ts), seulement en repli quand celles-ci concluent
 *   "ambigu" - aucun risque de regression sur les cas deja bien geres,
 *   uniquement des cas recuperes en plus.
 * - Consigne explicitement au modele de repondre "ambigu" au moindre
 *   doute, exactement comme le ferait la regle deterministe.
 * - Le resultat reste marque comme "classe par IA" (DocumentFournisseur.
 *   classifiePar) plutot que traite silencieusement comme un match certain :
 *   transparence totale dans l'interface.
 * - Ne declenche jamais un envoi automatique vers Dext, meme si
 *   DEXT_AUTO_FORWARD est actif (voir gmailSync.ts) : une classification
 *   par IA attend toujours une confirmation manuelle, contrairement a un
 *   match par mot-cle sur "facture" qui reste, lui, un signal jugee assez
 *   fiable pour continuer a etre transmis automatiquement.
 * - Toute erreur (cle manquante, panne reseau, reponse inattendue) est
 *   silencieusement traitee comme "pas d'avis" : le document retombe sur
 *   le comportement actuel (ambigu, centre de validation), jamais une
 *   panne de ce filet ne bloque ou ne fausse la synchronisation.
 */

const MODELE = "claude-sonnet-5";

// Categories reelles seulement : le modele ne doit jamais halluciner un
// type inexistant. "ambigu" reste une reponse valide et attendue.
const TYPES_VALIDES: TypeDocument[] = ["facture", "avoir", "bon_enlevement", "releve", "devis", "ambigu"];

const OUTIL_CLASSIFICATION: Anthropic.Tool = {
  name: "classer_document",
  description: "Enregistre le type de document identifie.",
  input_schema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: TYPES_VALIDES,
        description:
          "facture : demande de paiement pour une livraison/prestation. " +
          "avoir : note de credit annulant tout ou partie d'une facture anterieure. " +
          "bon_enlevement : document logistique attestant un retrait/enlevement de marchandise, pas une demande de paiement. " +
          "releve : recapitulatif periodique de plusieurs factures d'un fournisseur (releve de compte/de factures). " +
          "devis : proposition commerciale/offre de prix, jamais une demande de paiement ferme. " +
          "ambigu : impossible de determiner le type avec une confiance raisonnable a partir du texte fourni.",
      },
    },
    required: ["type"],
  },
};

const PROMPT_SYSTEME = `Tu identifies le type d'un document comptable recu par e-mail par un artisan \
plombier francais, a partir de son sujet, du debut du corps du message, du \
nom de fichier et, si disponible, du texte extrait du document lui-meme.

Regle absolue : en cas de moindre doute, ou si le texte ne contient pas \
assez d'information pour trancher avec confiance, reponds "ambigu". Ne \
devine jamais pour completer une reponse plus "utile" - une reponse \
"ambigu" incorrecte n'a aucune consequence (le document part en \
validation humaine), alors qu'une reponse erronee presentee comme certaine \
peut entrainer un mauvais traitement comptable. Appelle systematiquement \
l'outil classer_document avec ta conclusion.`;

/**
 * Tente de classer un document a partir de son contexte textuel complet.
 * Retourne null si aucun avis fiable n'a pu etre obtenu (cle absente,
 * erreur d'appel, reponse invalide) - jamais une erreur qui remonterait
 * jusqu'a l'appelant et interromprait la synchronisation Gmail.
 */
export async function classifierParIA(contexte: string): Promise<TypeDocument | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const client = new Anthropic({ apiKey });
    // Tronque a une longueur raisonnable : le texte extrait d'un PDF
    // multi-pages peut etre tres long, sans que les dernieres pages
    // apportent un signal supplementaire utile a cette seule decision.
    const texte = contexte.trim().slice(0, 6000);
    if (!texte) return null;

    const reponse = await client.messages.create({
      model: MODELE,
      max_tokens: 200,
      system: PROMPT_SYSTEME,
      tools: [OUTIL_CLASSIFICATION],
      tool_choice: { type: "tool", name: "classer_document" },
      messages: [{ role: "user", content: texte }],
    });

    const appel = reponse.content.find((bloc): bloc is Anthropic.ToolUseBlock => bloc.type === "tool_use");
    const type = (appel?.input as { type?: string } | undefined)?.type;
    if (type && (TYPES_VALIDES as string[]).includes(type)) {
      return type as TypeDocument;
    }
    return null;
  } catch {
    return null;
  }
}
