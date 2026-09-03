/**
 * Classification deterministe des pieces jointes recues par mail (section
 * 7.2 du cahier des charges). Volontairement fondee sur des regles
 * explicites plutot que sur une interpretation libre : "les regles metier
 * deterministes priment sur une interpretation libre de l'IA" (section 14).
 * Tout ce qui ne correspond a aucune regle connue devient "ambigu" et part
 * au centre de validation plutot que d'etre devine (section 7.2, 14).
 */

export type TypeDocument = "facture" | "avoir" | "bon_enlevement" | "releve" | "ambigu";

export interface PieceJointe {
  nomFichier: string;
  mimeType: string;
}

export interface EmailAClassifier {
  sujet: string;
  expediteur: string;
  extraitCorps: string;
  piecesJointes: PieceJointe[];
}

const MIME_TYPES_DOCUMENT = ["application/pdf", "image/jpeg", "image/png", "image/tiff"];

const MOTIF_BON_ENLEVEMENT = /bon[\s.-]*d['\s]*enl[eè]vement|bon[\s.-]*de[\s.-]*sortie|bordereau[\s.-]*d['\s]*enl[eè]vement/i;
const MOTIF_RELEVE = /relev[eé][\s.-]*(de[\s.-]*)?factures?|relev[eé][\s.-]*fournisseur|statement[\s.-]*of[\s.-]*account/i;
const MOTIF_AVOIR = /\bavoir\b|note[\s.-]*de[\s.-]*cr[eé]dit|credit[\s.-]*note/i;
const MOTIF_FACTURE = /\bfacture\b|\binvoice\b|\bfattura\b/i;

function estPieceDocument(piece: PieceJointe): boolean {
  return MIME_TYPES_DOCUMENT.includes(piece.mimeType.toLowerCase());
}

/**
 * Classe une seule piece jointe a partir de son propre nom de fichier et
 * du contexte du mail (sujet + debut du corps), qui priment sur le nom du
 * fichier lorsqu'ils se contredisent (le nom de fichier est souvent
 * generique, ex. "scan0001.pdf").
 */
export function classifierPieceJointe(email: EmailAClassifier, piece: PieceJointe): TypeDocument {
  if (!estPieceDocument(piece)) return "ambigu";

  const texte = `${email.sujet} ${email.extraitCorps} ${piece.nomFichier}`;

  if (MOTIF_BON_ENLEVEMENT.test(texte)) return "bon_enlevement";
  if (MOTIF_RELEVE.test(texte)) return "releve";
  if (MOTIF_AVOIR.test(texte)) return "avoir";
  if (MOTIF_FACTURE.test(texte)) return "facture";

  // Cas standard section 7.4 : beaucoup de fournisseurs envoient une
  // facture en piece jointe sans jamais employer le mot "facture" dans le
  // sujet ou le corps. Un document (PDF/image) unique sans autre indice
  // negatif est traite comme facture standard plutot que comme ambigu,
  // pour ne pas noyer le centre de validation de faux positifs — mais
  // seulement si rien n'indique un des autres types.
  return "facture";
}

/**
 * Adresse Dext cible (section 7.1) : une facture par e-mail utilise
 * l'adresse standard ; plusieurs factures dans le meme e-mail (plusieurs
 * pieces jointes classees "facture") utilisent l'adresse "multiple".
 */
export function choisirAdresseDext(nbFacturesDansLEmail: number): string {
  return nbFacturesDansLEmail > 1 ? "facturation-brochant@multiple.dext.cc" : "facturation-brochant@dext.cc";
}

/**
 * Extraction best-effort d'un numero de facture lisible (section 7.3), a
 * partir du nom de fichier ou du sujet. Purement indicative : l'absence de
 * numero n'empeche jamais le traitement, elle prive seulement d'un signal
 * de doublon supplementaire.
 */
export function extraireNumeroFacture(texte: string): string | null {
  const m = texte.match(/(?:facture|invoice|n°|no|num(?:ero)?)[\s:.#-]*([A-Z0-9][A-Z0-9\-\/]{2,20})/i);
  return m ? m[1] : null;
}
