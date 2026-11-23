import { Prisma, PrismaClient } from "@prisma/client";

/**
 * Fiche Fournisseurs (section 6 du cahier des charges, Phase 4).
 *
 * Aucun import dedie n'existe pour les fournisseurs (contrairement aux
 * clients, qui arrivent par l'export Synec) : le seul signal disponible est
 * l'expediteur des documents recus par e-mail (`DocumentFournisseur.gmailExpediteur`,
 * deja stocke pour chaque document). `resoudreFournisseur` en derive un nom
 * de fournisseur de facon deterministe (section 14 : jamais d'invention),
 * cree la fiche au premier document recu, et reutilise ensuite la meme
 * fiche pour tout document ulterieur du meme expediteur.
 */

const FOURNISSEURS_MESSAGERIE_GRAND_PUBLIC = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.fr",
  "hotmail.com",
  "hotmail.fr",
  "yahoo.com",
  "yahoo.fr",
  "free.fr",
  "orange.fr",
  "wanadoo.fr",
  "laposte.net",
  "icloud.com",
  "sfr.fr",
  "bbox.fr",
]);

function nettoyerEspaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** "Cedeo Paris" reste tel quel ; "CEDEO PARIS" (tout en majuscules) est mis en casse titre pour rester lisible. */
function normaliserCasse(nom: string): string {
  if (nom === nom.toUpperCase() && /[A-Z]/.test(nom)) {
    return nom
      .toLowerCase()
      .split(" ")
      .map((mot) => (mot.length > 0 ? mot[0].toUpperCase() + mot.slice(1) : mot))
      .join(" ");
  }
  return nom;
}

/** "point-p.fr" / "www.cedeo.fr" -> "Point P" / "Cedeo". */
function nomDepuisDomaine(domaine: string): string {
  const segments = domaine.toLowerCase().split(".").filter((s) => s !== "www");
  // Le libelle metier est generalement l'avant-dernier segment (le domaine
  // proprement dit, hors sous-domaine eventuel et hors extension finale).
  const base = segments.length >= 2 ? segments[segments.length - 2] : segments[0] || domaine;
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((mot) => mot[0].toUpperCase() + mot.slice(1))
    .join(" ");
}

export interface IdentiteExpediteur {
  nom: string;
  email: string | null;
}

// Un "nom affiche" qui ressemble a une personne physique (le contact
// commercial chez le fournisseur, pas le fournisseur lui-meme) plutot qu'a
// une raison sociale : demande explicite de l'utilisateur (ex. "Alexandre
// CECCARELLO" <aceccarello@incomm.fr> cree une fiche "Alexandre CECCARELLO"
// au lieu de "Incomm"). Volontairement restreint a deux formes tres
// specifiques et peu susceptibles de faux positifs sur une vraie raison
// sociale (section 14 : jamais deviner au sens large) :
//  - "Prenom NOM" (prenom en casse normale, nom de famille tout en
//    majuscules) : convention de signature tres repandue en France, qu'une
//    raison sociale ne prend quasiment jamais (ex. "Alexandre CECCARELLO",
//    "Claire BARTHELET").
//  - "Nom, Prenom" (avec virgule) : une raison sociale ne contient
//    pratiquement jamais de virgule dans son nom affiche (ex. "Khelifa,
//    Redouan").
// Deliberement PAS "PRENOM NOM" (tout en majuscules) ni une detection de
// mots-cles : ces formes recoupent trop de vraies raisons sociales (ex.
// "GROUPE SAMSE", "CEDEO PARIS") pour rester surs sans une liste de mots
// metier a maintenir indefiniment.
const MOTIF_NOM_PRENOM_VIRGULE = /^[A-ZÀ-Ý][a-zà-ÿ'-]+,\s*[A-ZÀ-Ý][a-zà-ÿ'-]+$/;
const MOTIF_PRENOM_NOM_MAJUSCULES = /^[A-ZÀ-Ý][a-zà-ÿ'-]+\s+[A-ZÀ-Ý]{2,}$/;

function ressembleANomDePersonne(nom: string): boolean {
  return MOTIF_NOM_PRENOM_VIRGULE.test(nom) || MOTIF_PRENOM_NOM_MAJUSCULES.test(nom);
}

const MOTIF_EMAIL = /^[^\s<>@]+@[^\s<>@]+$/;
const MOTIF_EMAIL_ENTRE_PARENTHESES = /\(([^()\s]+@[^()\s]+)\)/;

/**
 * Extrait un nom de fournisseur exploitable a partir d'un en-tete "From"
 * Gmail (`"Cedeo Paris" <contact@cedeo.fr>` ou simplement `contact@cedeo.fr`).
 * Priorite au nom affiche s'il existe (le plus fiable), sinon derive du
 * domaine de messagerie — sauf s'il s'agit d'une messagerie grand public
 * (gmail.com...), auquel cas l'adresse elle-meme sert de nom plutot que
 * d'inventer une fausse raison sociale a partir de "Gmail".
 */
export function extraireIdentiteExpediteur(expediteur: string): IdentiteExpediteur {
  const brut = expediteur.trim();
  // L'adresse recherchee est celle du DERNIER "<...>" de la chaine, jamais
  // une regex stricte "guillemets ouvrants/fermants" sur le nom affiche :
  // certains expediteurs reels envoient un en-tete mal forme (ex. WeFix,
  // nom affiche contenant des guillemets internes mal echappes -
  // `"\"L'équipe WeFix\" " <mailing@wefix.net>`) que cette derniere
  // approche ne reconnaissait pas du tout, faisant echouer toute extraction
  // et remonter l'en-tete brut tel quel comme "nom" (signale par
  // l'utilisateur : fournisseur affiche comme une adresse e-mail illisible).
  // Les guillemets (echappes ou non) sont ensuite simplement retires du
  // reste de la chaine plutot que d'etre apparies - narrower, mais ne casse
  // aucun cas bien forme existant (verifie par les tests).
  const avecEmailEntreChevrons = brut.match(/^(.*)<([^<>]+)>\s*$/);

  let nomAffiche = "";
  let email: string | null = null;

  if (avecEmailEntreChevrons) {
    email = avecEmailEntreChevrons[2].trim().toLowerCase();
    nomAffiche = nettoyerEspaces(avecEmailEntreChevrons[1].replace(/\\?"/g, ""));
  } else if (MOTIF_EMAIL.test(brut)) {
    email = brut.toLowerCase();
  }

  // Nom affiche qui encode en realite une adresse e-mail entre parentheses
  // (vu en production : systemes d'envoi automatise type NetSuite, ou
  // l'expediteur technique reel - ex. system@sent-via.netsuite.com - n'a
  // aucun rapport avec le fournisseur, le vrai contact etant enfoui dans le
  // nom affiche lui-meme, ex. "Alain Picard NL (alain.picard@masternaut.com)").
  // Derive alors le nom du domaine de cette adresse embarquee plutot que de
  // garder un prefixe illisible ou l'expediteur technique, qui n'identifient
  // ni l'un ni l'autre le vrai fournisseur.
  const emailEntreParentheses = nomAffiche.match(MOTIF_EMAIL_ENTRE_PARENTHESES);
  if (emailEntreParentheses) {
    const domaineEmbarque = (emailEntreParentheses[1].split("@")[1] || "").toLowerCase();
    if (domaineEmbarque && !FOURNISSEURS_MESSAGERIE_GRAND_PUBLIC.has(domaineEmbarque)) {
      return { nom: nomDepuisDomaine(domaineEmbarque), email };
    }
  }

  // Nom affiche qui EST lui-meme une adresse e-mail (certains systemes la
  // repetent faute de nom configure, ex. `"t.reymond@leongrosse.fr"
  // <t.reymond@leongrosse.fr>`, vu en production) : n'identifie pas
  // davantage le fournisseur qu'une absence de nom affiche - traite donc de
  // la meme facon, en repli sur le domaine ci-dessous plutot que d'afficher
  // l'adresse telle quelle comme si c'etait une raison sociale.
  if (MOTIF_EMAIL.test(nomAffiche)) {
    nomAffiche = "";
  }

  // Le nom affiche d'un contact commercial individuel (voir
  // ressembleANomDePersonne) n'identifie pas le fournisseur lui-meme :
  // prefere alors le nom derive du domaine, exactement comme en l'absence
  // de nom affiche - sauf messagerie grand public, ou aucune raison
  // sociale fiable ne peut en etre deduite.
  if (nomAffiche && email && ressembleANomDePersonne(nomAffiche)) {
    const domaine = email.split("@")[1] || "";
    if (domaine && !FOURNISSEURS_MESSAGERIE_GRAND_PUBLIC.has(domaine)) {
      return { nom: nomDepuisDomaine(domaine), email };
    }
  }

  if (nomAffiche) return { nom: normaliserCasse(nomAffiche), email };

  if (email) {
    const domaine = email.split("@")[1] || "";
    if (domaine && !FOURNISSEURS_MESSAGERIE_GRAND_PUBLIC.has(domaine)) {
      return { nom: nomDepuisDomaine(domaine), email };
    }
    return { nom: email, email };
  }

  return { nom: brut || "Expéditeur inconnu", email: null };
}

/**
 * Retrouve la fiche fournisseur correspondant a cet expediteur, ou la cree
 * si c'est le premier document recu de sa part. `cache` (facultatif) evite
 * une requete repetee pour le meme expediteur au sein d'une meme
 * synchronisation (meme principe que le cache de libelles Gmail).
 *
 * `nomDocumentIA` (facultatif) : nom du fournisseur tel que lu sur le
 * document lui-meme par l'extraction IA (ChampsFacture.fournisseurNom, voir
 * archiveComptableIA.ts), quand elle a deja ete executee pour en extraire
 * les montants. Prioritaire sur le nom derive de l'expediteur de l'e-mail
 * quand il est fourni (demande explicite de l'utilisateur : une facture
 * transmise via un intermediaire/portail d'e-facturation - ex. un expediteur
 * "e-Facture PA" pour une facture Leroy Merlin - doit porter le nom du
 * fournisseur reel imprime sur le document, pas celui de l'intermediaire qui
 * l'a transmise). Jamais invente : absent/vide, on retombe sur l'expediteur
 * comme avant (section 14, "jamais deviner").
 */
export async function resoudreFournisseur(
  prisma: PrismaClient,
  expediteur: string,
  cache?: Map<string, string>,
  nomDocumentIA?: string | null
): Promise<string> {
  const nom = nomDocumentIA && nomDocumentIA.trim() ? normaliserCasse(nettoyerEspaces(nomDocumentIA)) : extraireIdentiteExpediteur(expediteur).nom;

  const enCache = cache?.get(nom);
  if (enCache) return enCache;

  try {
    const fournisseur = await prisma.fournisseur.upsert({
      where: { nom },
      update: {},
      create: { nom, modeReception: "email" },
    });
    cache?.set(nom, fournisseur.id);
    return fournisseur.id;
  } catch (err) {
    // Cas rare : deux documents du meme expediteur traites en parallele se
    // disputent la creation (violation de contrainte unique sur "nom").
    // Le upsert de Prisma ne couvre pas cette course ; on relit simplement
    // la fiche qui vient d'etre creee par l'autre appel plutot que
    // d'echouer tout le traitement du document.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existant = await prisma.fournisseur.findUnique({ where: { nom } });
      if (existant) {
        cache?.set(nom, existant.id);
        return existant.id;
      }
    }
    throw err;
  }
}

export interface ResumeFournisseur {
  id: string;
  nom: string;
  modeReception: string | null;
  nbDocuments: number;
  nbFactures: number;
  nbEnAttente: number;
  dernierDocumentLe: string | null;
}

/** Liste des fournisseurs avec un resume d'activite, les plus recents en premier. */
export async function listerFournisseurs(prisma: PrismaClient): Promise<ResumeFournisseur[]> {
  const fournisseurs = await prisma.fournisseur.findMany({
    include: { documents: { select: { type: true, statutDext: true, createdAt: true } } },
  });

  return fournisseurs
    .map((f) => {
      const dernier = f.documents.reduce<Date | null>((max, d) => (!max || d.createdAt > max ? d.createdAt : max), null);
      return {
        id: f.id,
        nom: f.nom,
        modeReception: f.modeReception,
        nbDocuments: f.documents.length,
        nbFactures: f.documents.filter((d) => d.type === "facture").length,
        nbEnAttente: f.documents.filter((d) => d.statutDext === "a_valider").length,
        dernierDocumentLe: dernier ? dernier.toISOString() : null,
      };
    })
    .sort((a, b) => (b.dernierDocumentLe || "").localeCompare(a.dernierDocumentLe || ""));
}

/** Detail d'un fournisseur : sa fiche et l'historique complet de ses documents. */
export async function obtenirFournisseur(prisma: PrismaClient, fournisseurId: string) {
  const fournisseur = await prisma.fournisseur.findUnique({
    where: { id: fournisseurId },
    include: { documents: { orderBy: { createdAt: "desc" } } },
  });
  return fournisseur;
}

export class FournisseurAvecFacturesError extends Error {}

/**
 * Supprime une fiche fournisseur creee a tort (expediteur qui n'est pas un
 * vrai fournisseur : secretariat, notification automatique, mauvaise
 * classification anterieure au correctif de section 7...). Refuse si au
 * moins une facture reelle lui est deja rattachee : un fournisseur avec de
 * vraies factures n'est jamais du bruit, mieux vaut laisser la decision a
 * l'utilisateur plutot que de deviner (section 14).
 *
 * La contrainte de cle etrangere (ON DELETE SET NULL) detache simplement
 * les documents et factures eventuels plutot que de les supprimer : rien
 * n'est perdu, seul le rattachement au fournisseur disparait.
 */
export async function supprimerFournisseur(prisma: PrismaClient, fournisseurId: string): Promise<void> {
  const fournisseur = await prisma.fournisseur.findUnique({
    where: { id: fournisseurId },
    include: { factures: { select: { id: true }, take: 1 } },
  });
  if (!fournisseur) throw new Error("Fournisseur introuvable.");
  if (fournisseur.factures.length > 0) {
    throw new FournisseurAvecFacturesError("Ce fournisseur a au moins une facture reelle rattachee, suppression refusee.");
  }
  await prisma.fournisseur.delete({ where: { id: fournisseurId } });
}

/**
 * Renomme une fiche fournisseur creee a tort sous le nom d'un contact
 * commercial individuel plutot que la raison sociale elle-meme (voir
 * ressembleANomDePersonne plus haut, et son usage dans
 * extraireIdentiteExpediteur) - corrige retroactivement les fiches deja
 * creees avant ce correctif, jamais automatique (demande explicite de
 * l'utilisateur, depuis l'interface).
 *
 * Si une fiche porte deja le nom cible (ex. "Incomm" existe deja quand on
 * corrige "Alexandre CECCARELLO"), fusionne au lieu d'entrer en conflit
 * avec la contrainte d'unicite sur le nom : tous les documents et factures
 * de la fiche source rejoignent la fiche cible existante (jamais
 * l'inverse, pour conserver l'historique le plus ancien), puis la fiche
 * source, desormais vide, est supprimee. Rien n'est jamais perdu, seul le
 * doublon de fiche disparait.
 */
export async function renommerFournisseur(prisma: PrismaClient, fournisseurId: string, nouveauNomBrut: string): Promise<{ fusionneAvec: string | null }> {
  const nouveauNom = nettoyerEspaces(nouveauNomBrut);
  if (!nouveauNom) throw new Error("Nom vide.");

  const fournisseur = await prisma.fournisseur.findUnique({ where: { id: fournisseurId } });
  if (!fournisseur) throw new Error("Fournisseur introuvable.");
  if (fournisseur.nom === nouveauNom) return { fusionneAvec: null };

  const cible = await prisma.fournisseur.findUnique({ where: { nom: nouveauNom } });
  if (!cible) {
    await prisma.fournisseur.update({ where: { id: fournisseurId }, data: { nom: nouveauNom } });
    return { fusionneAvec: null };
  }
  if (cible.id === fournisseurId) return { fusionneAvec: null };

  await prisma.$transaction([
    prisma.documentFournisseur.updateMany({ where: { fournisseurId }, data: { fournisseurId: cible.id } }),
    prisma.factureFournisseur.updateMany({ where: { fournisseurId }, data: { fournisseurId: cible.id } }),
    prisma.fournisseur.delete({ where: { id: fournisseurId } }),
  ]);
  return { fusionneAvec: cible.nom };
}

export interface ResultatCorrectionNomsFournisseurs {
  examines: number;
  corriges: Array<{ fournisseurId: string; ancienNom: string; nouveauNom: string; fusionne: boolean }>;
}

/**
 * Corrige retroactivement les fiches fournisseur creees avec un nom
 * illisible (adresse e-mail brute, en-tete mal forme...) avant les
 * correctifs successifs de extraireIdentiteExpediteur ci-dessus - demande
 * explicite de l'utilisateur apres avoir repere plusieurs fiches de ce
 * type en production (ex. "t.reymond@leongrosse.fr", "L'équipe WeFix"
 * affiche avec des guillemets internes, "Alain Picard NL (...)").
 *
 * Pour chaque fiche, recalcule le nom a partir de TOUS les expediteurs
 * Gmail connus de ses documents (jamais un seul pris au hasard) : ne
 * corrige que si TOUS s'accordent sur le meme nom recalcule (consensus
 * unanime) et que celui-ci differe du nom actuel - une fiche dont les
 * documents ont ete rattaches manuellement a des expediteurs differents
 * n'est jamais touchee, par prudence (jamais de choix arbitraire). Fusionne
 * avec une fiche cible existante le cas echeant (voir renommerFournisseur),
 * sans rien perdre. Sans effet, et donc sans risque, a rejouer plusieurs
 * fois.
 */
export async function corrigerNomsFournisseursDepuisExpediteur(prisma: PrismaClient): Promise<ResultatCorrectionNomsFournisseurs> {
  const fournisseurs = await prisma.fournisseur.findMany({
    include: { documents: { where: { gmailExpediteur: { not: null } }, select: { gmailExpediteur: true } } },
  });

  const corriges: ResultatCorrectionNomsFournisseurs["corriges"] = [];
  for (const f of fournisseurs) {
    const expediteurs = f.documents.map((d) => d.gmailExpediteur).filter((e): e is string => Boolean(e));
    if (expediteurs.length === 0) continue;

    const nomsRecalcules = new Set(expediteurs.map((e) => extraireIdentiteExpediteur(e).nom));
    if (nomsRecalcules.size !== 1) continue;
    const [nomRecalcule] = nomsRecalcules;
    if (!nomRecalcule || nomRecalcule === f.nom) continue;

    const resultat = await renommerFournisseur(prisma, f.id, nomRecalcule);
    corriges.push({ fournisseurId: f.id, ancienNom: f.nom, nouveauNom: nomRecalcule, fusionne: resultat.fusionneAvec !== null });
  }

  return { examines: fournisseurs.length, corriges };
}

/**
 * Supprime un document rattache a tort a une fiche fournisseur (ex. un CV ou
 * une photo mal classes qui restent visibles dans "Voir les documents" meme
 * s'ils n'ont jamais ete transmis a Dext), ou une facture envoyee a Dext par
 * erreur (ex. doublon, mauvais fournisseur) - demande explicite de
 * l'utilisateur, depuis l'interface.
 *
 * IMPORTANT (section 14 : jamais deviner) : l'application n'a aucun acces a
 * l'API de Dext, seulement a l'adresse e-mail d'import
 * (facturation-brochant@dext.cc, voir envoyerVersDext dans gmailSync.ts).
 * Cette suppression ne retire donc QUE le suivi local - si le document a
 * deja ete recu et traite par Dext, il faut aussi le supprimer directement
 * dans Dext. Le frontend previent l'utilisateur de cette limite avant
 * confirmation (voir supprimerDocumentFournisseur dans app.js).
 */
export async function supprimerDocumentFournisseur(prisma: PrismaClient, documentId: string): Promise<void> {
  const document = await prisma.documentFournisseur.findUnique({ where: { id: documentId } });
  if (!document) throw new Error("Document introuvable.");
  await prisma.documentFournisseur.delete({ where: { id: documentId } });
}

export class MontantDocumentFournisseurError extends Error {}

export interface MontantsFacture {
  montantHT?: number | null;
  montantTTC?: number | null;
}

/**
 * Saisie manuelle du montant HT et/ou TTC d'une facture fournisseur, quand
 * l'extraction automatique (extraireMontantHTFacture/extraireMontantTTCFacture,
 * voir gmailClassify.ts) n'a pas trouve de montant exploitable dans le
 * document (mise en page atypique, releve mensuel recapitulant plusieurs
 * factures...) - demande explicite de l'utilisateur, avec un montant jamais
 * invente : l'absence reste visible (alerte cote interface) jusqu'a cette
 * saisie volontaire. Les deux montants sont independants : seul celui
 * fourni est mis a jour, l'autre reste inchange.
 */
export async function saisirMontantDocumentFournisseur(prisma: PrismaClient, documentId: string, montants: MontantsFacture): Promise<void> {
  const { montantHT, montantTTC } = montants;
  if (montantHT == null && montantTTC == null) {
    throw new MontantDocumentFournisseurError("Indiquez au moins un montant (HT ou TTC).");
  }
  for (const [libelle, valeur] of [
    ["HT", montantHT],
    ["TTC", montantTTC],
  ] as const) {
    if (valeur != null && (!Number.isFinite(valeur) || valeur <= 0)) {
      throw new MontantDocumentFournisseurError(`Le montant ${libelle} doit être un nombre positif.`);
    }
  }
  const document = await prisma.documentFournisseur.findUnique({ where: { id: documentId } });
  if (!document) throw new MontantDocumentFournisseurError("Document introuvable.");
  await prisma.documentFournisseur.update({
    where: { id: documentId },
    data: {
      ...(montantHT != null ? { montantHT } : {}),
      ...(montantTTC != null ? { montantTTC } : {}),
    },
  });
}

export class FournisseurDocumentError extends Error {}

/**
 * Corrige a la main le fournisseur d'un document, quand la resolution
 * automatique (resoudreFournisseur, a partir de l'expediteur de l'e-mail)
 * n'a rien trouve d'exploitable - demande explicite de l'utilisateur,
 * apres une facture scannee/reclassee manuellement ("centre de validation
 * des anomalies") qui ne passe jamais par resoudreFournisseur et reste
 * donc sans fournisseur assigne (ex. un ticket de carte bancaire station
 * E.Leclerc envoye en piece jointe a soi-meme pour archivage). Retrouve un
 * fournisseur existant par son nom exact (meme table que les fournisseurs
 * resolus automatiquement par e-mail - ni doublon, ni distinction cachee
 * entre les deux origines) ou en cree un nouveau si aucun ne correspond.
 */
export async function assignerFournisseurDocument(prisma: PrismaClient, documentId: string, nomFournisseurBrut: string): Promise<void> {
  const nom = nomFournisseurBrut.trim();
  if (!nom) throw new FournisseurDocumentError("Le nom du fournisseur est requis.");

  const document = await prisma.documentFournisseur.findUnique({ where: { id: documentId } });
  if (!document) throw new FournisseurDocumentError("Document introuvable.");

  const fournisseur = await prisma.fournisseur.upsert({
    where: { nom },
    update: {},
    create: { nom },
  });
  await prisma.documentFournisseur.update({ where: { id: documentId }, data: { fournisseurId: fournisseur.id } });
}

/**
 * Enregistre un fournisseur par son seul nom, sans document associe -
 * demande explicite de l'utilisateur (liste de fournisseurs identifies dans
 * l'archive Comptabilite, a enregistrer meme sans facture Dext/e-mail
 * correspondante). Meme table que les fournisseurs resolus automatiquement
 * (resoudreFournisseur) ou corriges a la main (assignerFournisseurDocument) -
 * ni doublon, ni distinction cachee : si le nom existe deja (recherche
 * exacte), ne fait rien plutot que de dupliquer.
 */
export async function enregistrerFournisseur(prisma: PrismaClient, nomBrut: string): Promise<{ nom: string; cree: boolean }> {
  const nom = nomBrut.trim();
  if (!nom) throw new FournisseurDocumentError("Le nom du fournisseur est requis.");

  const existant = await prisma.fournisseur.findUnique({ where: { nom } });
  if (existant) return { nom: existant.nom, cree: false };

  const cree = await prisma.fournisseur.create({ data: { nom } });
  return { nom: cree.nom, cree: true };
}
