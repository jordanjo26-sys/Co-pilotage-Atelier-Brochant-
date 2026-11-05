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
  const avecNomAffiche = brut.match(/^"?([^"<]*?)"?\s*<([^>]+)>\s*$/);

  let nomAffiche = "";
  let email: string | null = null;

  if (avecNomAffiche) {
    nomAffiche = nettoyerEspaces(avecNomAffiche[1]);
    email = avecNomAffiche[2].trim().toLowerCase();
  } else if (/^[^\s<>@]+@[^\s<>@]+$/.test(brut)) {
    email = brut.toLowerCase();
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
 */
export async function resoudreFournisseur(prisma: PrismaClient, expediteur: string, cache?: Map<string, string>): Promise<string> {
  const { nom } = extraireIdentiteExpediteur(expediteur);

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
