/**
 * Classification deterministe des pieces jointes recues par mail (section
 * 7.2 du cahier des charges). Volontairement fondee sur des regles
 * explicites plutot que sur une interpretation libre : "les regles metier
 * deterministes priment sur une interpretation libre de l'IA" (section 14).
 * Tout ce qui ne correspond a aucune regle connue devient "ambigu" et part
 * au centre de validation plutot que d'etre devine (section 7.2, 14).
 */

export type TypeDocument = "facture" | "avoir" | "bon_enlevement" | "releve" | "devis" | "autre" | "ambigu";

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
// Les relevés Cedeo reçus en production (exemple réel fourni par
// l'utilisateur, novembre 2026) n'ont pas forcément ce mot dans le
// sujet/corps de l'e-mail - seul le PDF lui-même s'auto-titre "Relevé
// <référence> du <date>" en tout début de document (ex. "Relevé
// 889C6004972251 du 31/10/2026 N° Client..."), à la différence d'une
// vraie facture qui s'auto-titre "Facture <référence> du <date>". Sans ce
// repli sur le contenu du PDF, un sujet/corps generique ferait retomber
// sur la détection "facture" ci-dessous (le mot "facture" apparaît aussi
// dans le relevé lui-même, dans l'en-tête de tableau "N° de facture et
// références") - risque reel de compter deux fois la meme depense
// (une fois via chaque facture individuelle, une fois via le relevé qui
// les recapitule).
const MOTIF_RELEVE_TITRE_DOCUMENT = /^\s*relev[eé]\s+\S+\s+du\s+\d{2}\/\d{2}\/\d{4}/i;
// "avoir" est a la fois le nom du document comptable ("Avoir n°123") ET
// l'un des verbes les plus courants du francais, presque toujours utilise
// dans des tournures qui n'ont rien a voir avec un avoir ("merci d'avoir
// choisi...", "apres avoir passe commande", "pour avoir plus d'informations")
// et qui apparaissent couramment en tete de sujet/corps d'un e-mail de
// facture standard (regression reelle en production, deux fois : d'abord
// via le contenu integral du PDF, puis via le sujet/corps meme apres avoir
// restreint le contexte). Plutot que le mot seul, n'accepter que ses
// usages typiques de nom de document : en tete de texte ("Avoir n°..."),
// precede d'un determinant ("votre avoir", "un avoir"...), ou suivi d'une
// reference ("avoir n°123").
const MOTIF_AVOIR =
  /^avoir\b|\b(?:un|une|cet|cette|votre|notre|mon|ma|son|sa|l['’])\s+avoir\b|\bavoir\s*n[°o]?\s*[:.#-]?\s*\d|note[\s.-]*de[\s.-]*cr[eé]dit|credit[\s.-]*note/i;
const MOTIF_FACTURE = /\bfacture\b|\binvoice\b|\bfattura\b/i;
const MOTIF_DEVIS = /\bdevis\b|offre[\s.-]*de[\s.-]*prix|offre[\s.-]*commerciale|\bquote\b|\bquotation\b|\bestimate\b/i;

// Expediteurs connus et explicitement non-fournisseurs (demande de
// l'utilisateur, novembre 2026) : une agence d'interim envoyant des CV de
// candidats (electriciens, plombiers...) pour des missions - jamais une
// facture, jamais a valider manuellement, contrairement a "ambigu" qui
// suppose un doute reel. Liste fermee et explicite plutot qu'une detection
// de contenu ("CV", "candidature"...) trop susceptible de faux positifs sur
// un vrai document fournisseur qui mentionnerait incidemment ces mots.
const DOMAINES_EXPEDITEURS_NON_FOURNISSEURS = [/@le-cercle-interimaire\.fr/i];

function estExpediteurNonFournisseurConnu(expediteur: string): boolean {
  return DOMAINES_EXPEDITEURS_NON_FOURNISSEURS.some((motif) => motif.test(expediteur));
}

// "Valority" est un DONNEUR D'ORDRE de l'utilisateur (confirme par
// l'utilisateur, novembre 2026) : une mission confiee par Valority genere
// une FACTURE DE VENTE (emise par l'utilisateur, a facturer A Valority ou
// au client final), jamais une facture fournisseur a l'utilisateur -
// l'inverse exact de la relation presumee par la regle "facture" ci-
// dessous. Un e-mail/fichier mentionnant "Valority" ne doit donc jamais
// creer de fiche fournisseur ni partir vers Dext (signale en production :
// fiches "Kenza GHILAS"/"YOBOUET Samaecken" creees a tort, au nom des
// clients finaux de Valority, avec la facture de vente envoyee a Dext).
// Detection par contenu (pas d'expediteur fixe connu, contrairement a
// DOMAINES_EXPEDITEURS_NON_FOURNISSEURS) : "Valority" est un nom propre
// suffisamment distinctif pour ne pas risquer de faux positif sur un vrai
// document fournisseur.
const MOTIF_DONNEUR_ORDRE_CONNU = /\bvalority\b/i;

function mentionneDonneurOrdreConnu(contexte: string): boolean {
  return MOTIF_DONNEUR_ORDRE_CONNU.test(contexte);
}

// "application/octet-stream" est le type MIME generique utilise par de
// nombreux systemes de facturation/ERP quand ils ne renseignent pas (ou
// mal) le type reel de la piece jointe - constate en production : une
// facture reelle (Trenois Decamps, fac01_01_004478982.pdf) envoyee en
// application/octet-stream tombait a tort en "ambigu" avant meme toute
// verification du sujet/corps, le type MIME declare ne correspondant a
// aucune entree de MIME_TYPES_DOCUMENT. On se rabat alors sur l'extension
// du nom de fichier, seul signal fiable restant dans ce cas precis - mais
// uniquement pour ce type generique, jamais pour un type MIME exotique et
// non ambigu (ex. "application/json") qui n'a aucune raison d'etre un
// document.
const EXTENSIONS_DOCUMENT = [".pdf", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".zip"];

// Certains fournisseurs (ex. TotalEnergies / cartes carburant) envoient
// leur facture par e-mail sous forme d'archive ZIP contenant le PDF,
// plutot qu'un PDF direct - voir importers/zipAttachment.ts pour
// l'extraction du texte. Le mimeType exact varie selon le client mail
// d'origine (application/zip la plupart du temps, mais aussi vu en
// production application/x-zip-compressed et octet-stream generique avec
// extension .zip).
const MIME_TYPES_ZIP = ["application/zip", "application/x-zip-compressed", "application/x-zip"];

export function estPieceJointeZip(mimeType: string, nomFichier: string): boolean {
  if (MIME_TYPES_ZIP.includes(mimeType.toLowerCase())) return true;
  return mimeType.toLowerCase() === "application/octet-stream" && nomFichier.toLowerCase().endsWith(".zip");
}

function aUneExtensionDocument(piece: PieceJointe): boolean {
  const nom = piece.nomFichier.toLowerCase();
  return EXTENSIONS_DOCUMENT.some((ext) => nom.endsWith(ext));
}

function estTypeGeneriqueOuInconnu(piece: PieceJointe): boolean {
  return piece.mimeType.toLowerCase() === "application/octet-stream";
}

export function estPieceDocument(piece: PieceJointe): boolean {
  if (MIME_TYPES_DOCUMENT.includes(piece.mimeType.toLowerCase())) return true;
  return estTypeGeneriqueOuInconnu(piece) && aUneExtensionDocument(piece);
}

function estPdf(piece: PieceJointe): boolean {
  if (piece.mimeType.toLowerCase() === "application/pdf") return true;
  return estTypeGeneriqueOuInconnu(piece) && piece.nomFichier.toLowerCase().endsWith(".pdf");
}

/**
 * Classe une seule piece jointe a partir de son propre nom de fichier, du
 * contexte du mail (sujet + debut du corps), et — pour un PDF — du texte
 * extrait de son propre contenu (`contenuExtrait`, voir
 * `extractPdfText` dans bankStatementPdf.ts, reutilise par
 * gmailSync.ts). Ce dernier est indispensable en pratique : beaucoup de
 * factures fournisseurs arrivent avec un sujet/corps generiques ("Voici
 * vos documents", pas un mot sur "facture"), le mot n'apparaissant que
 * dans le PDF lui-meme. Sans lire le contenu, ces factures reelles
 * tombaient a tort en ambigu (signale par l'utilisateur en production).
 */
export function classifierPieceJointe(email: EmailAClassifier, piece: PieceJointe, contenuExtrait?: string): TypeDocument {
  // Verifie l'expediteur avant toute chose, meme avant le filtre MIME : un
  // CV peut arriver en PDF comme en image, peu importe, jamais une facture
  // ni meme un cas ambigu dans ce cas precis (voir le commentaire de
  // DOMAINES_EXPEDITEURS_NON_FOURNISSEURS).
  if (estExpediteurNonFournisseurConnu(email.expediteur)) return "autre";

  // Contexte "sûr" (sujet, corps, nom de fichier) : ces quatre autres types
  // de document restent verifies UNIQUEMENT ici, jamais dans le contenu
  // integral du PDF. "avoir" en particulier est un mot francais tres
  // courant hors de son sens comptable ("pour avoir plus d'informations",
  // mentions legales de bas de page...) : l'ouvrir a tout le texte d'un PDF
  // multi-pages (necessaire pour reconnaitre une facture au sujet
  // generique, voir plus bas) ferait basculer en "avoir" - un type jamais
  // transmis a Dext ni signale en anomalie, donc invisible - une vraie
  // facture qui mentionne incidemment ce mot n'importe ou dans le document
  // (signale par l'utilisateur en production : une facture recue disparait
  // sans laisser de trace, ni dans les anomalies ni dans les factures).
  const contexte = `${email.sujet} ${email.extraitCorps} ${piece.nomFichier}`;

  // Verifie avant meme le filtre MIME, comme le filtre expediteur ci-dessus :
  // une mention de Valority (donneur d'ordre, voir MOTIF_DONNEUR_ORDRE_CONNU)
  // n'est jamais une facture fournisseur quel que soit le format de la piece
  // jointe.
  if (mentionneDonneurOrdreConnu(contexte)) return "autre";
  if (!estPieceDocument(piece)) return "ambigu";

  if (MOTIF_BON_ENLEVEMENT.test(contexte)) return "bon_enlevement";
  if (MOTIF_RELEVE.test(contexte) || MOTIF_RELEVE_TITRE_DOCUMENT.test(contenuExtrait || "")) return "releve";
  if (MOTIF_AVOIR.test(contexte)) return "avoir";
  // Une facture n'est jamais transmise a Dext si ce n'est pas un PDF : un
  // e-mail de facture contient souvent d'autres pieces jointes (logo de
  // signature en .jpg/.png par ex.) qui partagent le meme contexte
  // (le mot "facture" dans le sujet) mais ne sont pas la facture elle-meme.
  // Seul le PDF est retenu comme facture ; une image dans ce contexte reste
  // ambigue plutot que d'etre presumee etre la facture. Seule la detection
  // de facture regarde aussi le contenu extrait du PDF (contenuExtrait) :
  // c'est le seul type pour lequel un sujet generique ("Voici vos
  // documents") est un cas reel et frequent, le mot "facture" n'apparaissant
  // alors que dans le PDF lui-meme.
  if (MOTIF_FACTURE.test(`${contexte} ${contenuExtrait || ""}`) && estPdf(piece)) return "facture";
  // Un devis n'est ni une facture ni un cas ambigu : type connu et
  // reconnaissable, jamais transmis a Dext, jamais mis en attente de
  // validation (evite d'encombrer le centre de validation a chaque devis
  // recu d'un fournisseur). MAIS le mot "devis" seul est ambigu comme
  // "avoir" ci-dessus : un CLIENT qui ecrit "pouvez-vous me faire un
  // devis, voici des photos" (join avec des .jpg) declenchait a tort ce
  // type, creant une fiche "fournisseur" au nom du client (signale en
  // production : "Florian Czapura", 7 photos .jpg classees "devis").
  // Comme pour "facture", un vrai devis FOURNISSEUR (deja chiffre, avec
  // son propre en-tete) arrive quasi-systematiquement en PDF ; une image
  // dans ce contexte est bien plus probablement une photo de client
  // demandant un devis que le document lui-meme - laissee ambigue (centre
  // de validation) plutot que presumee fournisseur.
  if (MOTIF_DEVIS.test(contexte) && estPdf(piece)) return "devis";

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

// Ordre de priorite pour le TTC. "net a payer"/"a payer" delibrement EN
// DERNIER (et non en premier comme dans une version precedente) : sur une
// vraie facture Prolians payee par traite/prelevement automatique, "NET A
// PAYER" vaut 0,00 € (rien a regler directement) alors que le TOTAL TTC
// reel est de 27,25 € - utiliser "net a payer" en priorite y renvoyait a
// tort 0 € comme depense. Les libelles de total explicite (toujours
// representatifs du montant reel de la facture, quel que soit le mode de
// paiement) passent donc avant.
// "tot ttc" : abrege, vu sur un vrai ticket de carte bancaire (station
// E.Leclerc - format differe d'une facture classique, mais reste un
// libelle explicite et non ambigu) - au meme rang que "total ttc", pas de
// risque de confusion similaire a "net a payer".
// "montant du" : vu sur une vraie facture Emergent Labs Inc (abonnement
// emergent.sh, en dollars, sans notion de TVA francaise) - EN DERNIER,
// au meme rang que "net a payer"/"a payer" et pour la MEME raison : sur
// une facture partiellement reglee ou financee, le "montant du" restant
// peut etre 0 ou partiel alors que le total reel de la facture est plus
// eleve (jamais verifie sur une vraie facture Emergent Labs avec acompte,
// par precaution).
const MOTIFS_MONTANT_TTC_PAR_PRIORITE = [
  /montant\s*total\s*ttc/i,
  /total\s*€?\s*ttc/i,
  /montant\s*ttc/i,
  /tot\.?\s*ttc/i,
  /net\s*à\s*payer/i,
  /à\s*payer/i,
  /montant\s*d[ûu]/i,
];

// Memes principes que pour le TTC, pour le montant hors taxes (demande
// explicite de l'utilisateur : suivre aussi le HT, pas seulement le TTC).
// "€?" entre "total"/"montant" et "ht" : vu sur une vraie facture Kiloutou
// ("Total € HT"), le symbole monetaire s'intercale dans le libelle lui-meme.
// "net" seul, EN DERNIER (filet de securite, jamais prioritaire sur un
// vrai libelle HT) : vu sur un vrai ticket de carte bancaire (station
// E.Leclerc) qui n'ecrit jamais "HT", seulement "TOT TTC" / "TVA 20,00%" /
// "Net" (le montant hors taxes, par definition). Exclut explicitement
// "net à payer" (deja gere comme motif TTC ci-dessus, un sens totalement
// different : le reste a regler, pas le hors-taxes) et exige une limite de
// mot pour ne jamais matcher a l'interieur d'un autre mot (ex. "Internet").
const MOTIFS_MONTANT_HT_PAR_PRIORITE = [
  /montant\s*total\s*ht/i,
  /total\s*€?\s*ht/i,
  /montant\s*ht/i,
  /\bnet\b(?!\s*à\s*payer)/i,
];

// Un montant en euros s'ecrit avec deux conventions decimales reellement
// rencontrees en production : virgule francaise ("1 234,56", la plupart
// des fournisseurs) ou point anglo-saxon ("48.07", vu sur de vraies
// factures Leroy Merlin et Autobacs). Le motif accepte les deux (point,
// virgule OU espace comme separateur de milliers, suivi d'un point ou
// d'une virgule puis exactement deux decimales) ; normaliserMontant plus
// bas determine ensuite lequel est reellement le separateur decimal.
const MOTIF_NOMBRE = "\\d{1,3}(?:[.,\\s]\\d{3})*[.,]\\d{2}";

/**
 * Convertit le texte d'un montant ("1.234,56", "1,234.56" ou "48.07") en
 * nombre, quelle que soit sa convention decimale : le DERNIER separateur
 * ('.' ou ',') du texte est toujours le separateur decimal (toujours
 * suivi d'exactement deux chiffres dans ce contexte - des montants en
 * euros), tout separateur avant lui n'est que du regroupement de milliers.
 */
function normaliserMontant(brut: string): number {
  const nettoye = brut.replace(/[\s€]/g, "");
  const dernierSeparateur = Math.max(nettoye.lastIndexOf(","), nettoye.lastIndexOf("."));
  const partieEntiere = nettoye.slice(0, dernierSeparateur).replace(/[.,]/g, "");
  const partieDecimale = nettoye.slice(dernierSeparateur + 1);
  return Number(`${partieEntiere}.${partieDecimale}`);
}

/**
 * Cherche un montant associe a un libelle donne (ex. "Total TTC") dans le
 * texte extrait d'un PDF (toujours via `pdftotext -layout`, voir
 * extractPdfText dans bankStatementPdf.ts - les colonnes d'un tableau y
 * restent alignees entre deux lignes). Deux mises en page reellement
 * rencontrees en production :
 *  - le montant suit le libelle SUR LA MEME LIGNE (cas le plus frequent,
 *    ex. Cedeo "TOTAL TTC EUR 80,36") ;
 *  - le libelle n'est que l'en-tete d'une colonne de tableau, sa valeur
 *    se trouvant sur la ou les lignes suivantes, A LA MEME POSITION
 *    HORIZONTALE (ex. PUM Plastique : "TOTAL HT EUR ... TOTAL TTC ..."
 *    sur une ligne, les montants juste en-dessous) - pdftotext -layout
 *    aligne les colonnes d'un tableau entre son en-tete et ses valeurs,
 *    jamais a une position anterieure a celle du libelle.
 * Un libelle immediatement suivi d'un AUTRE MOT (au-dela d'une unite
 * monetaire "€"/"EUR" tout de suite apres) est ecarte : il qualifie une
 * ligne differente du vrai total recherche (ex. une vraie facture Leroy
 * Merlin imprime successivement "Total TTC sans remise", "Total TTC
 * remise fidélité"... avant son "Total TTC" final, le seul a retenir).
 * Quand le libelle apparait plusieurs fois (ex. "Total HT" a la fois comme
 * en-tete de colonne par ligne d'article ET comme total general dans le
 * recapitulatif final, vu sur une vraie facture JD Assainissement), la
 * DERNIERE occurrence valable est retenue : le recapitulatif general suit
 * toujours le detail des lignes dans la mise en page d'une facture.
 */
function trouverMontantPourMotif(texte: string, motif: RegExp): number | null {
  const motifNonQualifie = new RegExp(`${motif.source}(?:\\s*€|\\s*EUR)?(?!\\s{1,3}[a-zà-ÿ])`, "i");
  const lignes = texte.split("\n");
  let dernierTrouve: number | null = null;

  for (let i = 0; i < lignes.length; i++) {
    const correspondance = lignes[i].match(motifNonQualifie);
    if (!correspondance || correspondance.index == null) continue;
    const colonne = correspondance.index;

    const suite = lignes[i].slice(correspondance.index + correspondance[0].length);
    const surLaMemeLigne = suite.match(new RegExp(MOTIF_NOMBRE));
    if (surLaMemeLigne && surLaMemeLigne.index != null && surLaMemeLigne.index < 100) {
      dernierTrouve = normaliserMontant(surLaMemeLigne[0]);
      continue;
    }

    // Sinon, en-tete de tableau sur sa propre ligne : cherche dans la
    // prochaine ligne non vide le nombre le plus proche, en colonne, a
    // partir de la position du libelle (jamais avant, voir le
    // commentaire ci-dessus).
    for (let j = i + 1; j < Math.min(i + 4, lignes.length); j++) {
      if (!lignes[j].trim()) continue;
      let meilleur: { valeur: string; distance: number } | null = null;
      for (const correspondanceNombre of lignes[j].matchAll(new RegExp(MOTIF_NOMBRE, "g"))) {
        const position = correspondanceNombre.index ?? 0;
        if (position < colonne) continue;
        const distance = position - colonne;
        if (distance <= 80 && (!meilleur || distance < meilleur.distance)) {
          meilleur = { valeur: correspondanceNombre[0], distance };
        }
      }
      if (meilleur) dernierTrouve = normaliserMontant(meilleur.valeur);
      break;
    }
  }

  return dernierTrouve;
}

function extraireMontantParLibelles(texte: string, motifs: RegExp[]): number | null {
  for (const motif of motifs) {
    const montant = trouverMontantPourMotif(texte, motif);
    if (montant != null && Number.isFinite(montant) && montant > 0) return montant;
  }
  return null;
}

/**
 * Extraction best-effort du montant TTC d'une facture (demande explicite
 * de l'utilisateur : suivre les depenses par fournisseur) a partir du
 * texte extrait du PDF (section 7.2, meme source que la classification
 * elle-meme) - mise en page trop variable d'un fournisseur a l'autre pour
 * une garantie de succes (section 14, jamais deviner un format non vu) :
 * retourne null si aucun des libelles connus n'est trouve plutot que de
 * prendre le premier nombre venu sur la page (risque reel de confondre
 * avec un HT, une TVA ou une reference), laissant alors la saisie
 * manuelle du montant (voir la route PATCH dediee) avec une alerte
 * explicite plutot qu'un chiffre invente.
 */
export function extraireMontantTTCFacture(texte: string): number | null {
  return extraireMontantParLibelles(texte, MOTIFS_MONTANT_TTC_PAR_PRIORITE);
}

/** Meme logique que extraireMontantTTCFacture, pour le montant hors taxes. */
export function extraireMontantHTFacture(texte: string): number | null {
  return extraireMontantParLibelles(texte, MOTIFS_MONTANT_HT_PAR_PRIORITE);
}

/**
 * Repli explicite demande par l'utilisateur (video, novembre 2026, facture
 * Emergent Labs Inc en dollars - abonnement emergent.sh) : si le TTC a ete
 * trouve mais pas le HT, ET qu'aucune mention de TVA/VAT n'apparait nulle
 * part dans le document, le HT vaut le TTC (TVA = 0) plutot que de rester
 * "non renseigne". Une facture qui ne mentionne JAMAIS la TVA/VAT (ex. une
 * societe etrangere sans assujettissement francais) n'y est simplement pas
 * soumise - a la difference d'un vrai HT non trouve a cause d'une mise en
 * page non reconnue sur un document qui, lui, mentionne la TVA quelque part.
 */
export function completerMontantHTSansTva(texte: string, montantHT: number | null, montantTTC: number | null): number | null {
  if (montantHT != null) return montantHT;
  if (montantTTC != null && !/tva|vat/i.test(texte)) return montantTTC;
  return montantHT;
}
