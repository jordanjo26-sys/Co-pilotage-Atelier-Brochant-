/**
 * Classification deterministe des pieces jointes recues par mail (section
 * 7.2 du cahier des charges). Volontairement fondee sur des regles
 * explicites plutot que sur une interpretation libre : "les regles metier
 * deterministes priment sur une interpretation libre de l'IA" (section 14).
 * Tout ce qui ne correspond a aucune regle connue devient "ambigu" et part
 * au centre de validation plutot que d'etre devine (section 7.2, 14).
 */

export type TypeDocument = "facture" | "avoir" | "bon_enlevement" | "releve" | "devis" | "ambigu";

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
const MOTIF_DEVIS = /\bdevis\b|offre[\s.-]*de[\s.-]*prix|offre[\s.-]*commerciale|\bquote\b|\bquotation\b|\bestimate\b/i;

function estPieceDocument(piece: PieceJointe): boolean {
  return MIME_TYPES_DOCUMENT.includes(piece.mimeType.toLowerCase());
}

function estPdf(piece: PieceJointe): boolean {
  return piece.mimeType.toLowerCase() === "application/pdf";
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
  // Une facture n'est jamais transmise a Dext si ce n'est pas un PDF : un
  // e-mail de facture contient souvent d'autres pieces jointes (logo de
  // signature en .jpg/.png par ex.) qui partagent le meme contexte
  // (le mot "facture" dans le sujet) mais ne sont pas la facture elle-meme.
  // Seul le PDF est retenu comme facture ; une image dans ce contexte reste
  // ambigue plutot que d'etre presumee etre la facture.
  if (MOTIF_FACTURE.test(texte) && estPdf(piece)) return "facture";
  // Un devis n'est ni une facture ni un cas ambigu : type connu et
  // reconnaissable, jamais transmis a Dext, jamais mis en attente de
  // validation (evite d'encombrer le centre de validation a chaque devis
  // recu d'un fournisseur).
  if (MOTIF_DEVIS.test(texte)) return "devis";

  // Correctif suite a un incident reel (envois errones vers Dext, rejetes
  // en masse) : la recherche Gmail (has:attachment newer_than:7d) balaie
  // TOUTE la boite mail, pas seulement les fournisseurs — un PDF/image
  // quelconque sans le mot "facture" ne doit donc jamais partir vers Dext
  // par defaut. Conforme au principe enonce plus haut : ce qui ne
  // correspond a aucune regle connue devient ambigu (centre de
  // validation), jamais une facture presumee.
  return "ambigu";
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
