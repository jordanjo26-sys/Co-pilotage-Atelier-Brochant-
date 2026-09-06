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
