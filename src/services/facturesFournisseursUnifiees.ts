import { PrismaClient, Prisma } from "@prisma/client";

/**
 * Ecran "Factures fournisseurs" (V2, ecran prioritaire de la refonte UX/UI -
 * maquette fournie par l'utilisateur) : unifie dans UNE seule liste les deux
 * sources reelles de factures fournisseurs, choix confirme explicitement par
 * l'utilisateur ("Les deux reunis dans un seul ecran") :
 *  - DocumentFournisseur (pipeline Gmail/Dext, type="facture" uniquement -
 *    les autres types (avoir/bon_enlevement/releve/devis/ambigu/autre) ne
 *    sont pas des factures et restent geres par leurs ecrans existants :
 *    Fournisseurs (fiches/documents), centre d'anomalies pour "ambigu").
 *  - ArchiveComptable, a l'exclusion des lignes origine="dext_copie" : ce
 *    sont des copies automatiques d'un DocumentFournisseur deja envoye a
 *    Dext (voir archiverFactureEnvoyeeDext dans archiveComptable.ts) - les
 *    afficher ici aussi doublerait chaque facture passee par Dext. Les
 *    lignes origine=NULL (anterieures au marqueur, non reclassees avec
 *    certitude - voir la migration 20261122160000_archive_comptable_origine)
 *    restent affichees : jamais masquer une facture par hypothese.
 *
 * Fusion faite en memoire (deux requetes, normalisation, tri, pagination) :
 * pas de UNION SQL entre deux modeles Prisma distincts, et les volumes reels
 * (quelques centaines de factures) restent largement dans les clous pour ce
 * traitement cote serveur, meme approche que depensesFournisseurs.ts.
 */

export type StatutFactureUnifiee = "a_traiter" | "validee" | "a_corriger";

export interface FactureFournisseurUnifiee {
  id: string; // "document:<id>" | "archive:<id>" - identifiant compose pour le frontend
  source: "document_fournisseur" | "archive_comptable";
  sourceId: string;
  fournisseurNom: string | null;
  numero: string | null;
  date: Date | null;
  montantHT: number | null;
  montantTTC: number | null;
  statut: StatutFactureUnifiee;
  statutDetail: string;
  fichierNom: string | null;
  mimeType: string | null;
  rapprochementStatut: string | null;
  createdAt: Date;
}

export interface FiltresFacturesFournisseursUnifiees {
  recherche?: string;
  fournisseurNom?: string;
  statut?: StatutFactureUnifiee;
  anneeMois?: string; // "AAAA-MM" - raccourci, equivalent a dateDebut/dateFin du meme mois
  dateDebut?: string; // "AAAA-MM-JJ"
  dateFin?: string; // "AAAA-MM-JJ"
  page?: number;
  parPage?: number;
}

export interface ResultatFacturesFournisseursUnifiees {
  factures: FactureFournisseurUnifiee[];
  total: number;
  compteurs: { toutes: number; aTraiter: number; validees: number; aCorriger: number };
  montantTotalTTC: number;
  page: number;
  parPage: number;
}

function statutDocumentFournisseur(statutDext: string): { statut: StatutFactureUnifiee; detail: string } {
  if (statutDext === "envoye") return { statut: "validee", detail: "Envoyée à Dext" };
  if (statutDext === "archive") return { statut: "validee", detail: "Archivée (hors circuit Dext)" };
  if (statutDext === "a_valider") return { statut: "a_traiter", detail: "À valider avant envoi à Dext" };
  return { statut: "a_traiter", detail: "En attente d'envoi à Dext" };
}

function statutArchiveComptable(statut: string): { statut: StatutFactureUnifiee; detail: string } {
  if (statut === "complete") return { statut: "validee", detail: "Complète" };
  return { statut: "a_corriger", detail: "Informations à compléter" };
}

const PAR_PAGE_DEFAUT = 25;

/**
 * Bornes de periode resolues depuis soit le raccourci anneeMois, soit des
 * dates libres dateDebut/dateFin (jamais les deux a la fois - anneeMois
 * est prioritaire s'il est fourni). Retourne undefined si aucune borne
 * n'est demandee ("Toutes les periodes").
 */
function resoudreBornesPeriode(filtres: FiltresFacturesFournisseursUnifiees): { debut?: Date; fin?: Date } | undefined {
  if (filtres.anneeMois) {
    const [annee, mois] = filtres.anneeMois.split("-").map(Number);
    return { debut: new Date(annee, mois - 1, 1), fin: new Date(annee, mois, 0, 23, 59, 59, 999) };
  }
  if (filtres.dateDebut || filtres.dateFin) {
    return {
      debut: filtres.dateDebut ? new Date(`${filtres.dateDebut}T00:00:00`) : undefined,
      fin: filtres.dateFin ? new Date(`${filtres.dateFin}T23:59:59.999`) : undefined,
    };
  }
  return undefined;
}

/**
 * Une facture est "dans la periode" si sa date tombe dans les bornes - OU
 * si elle n'a tout simplement pas de date lisible : une date manquante ou
 * incorrecte ne doit JAMAIS faire disparaitre silencieusement une facture
 * d'une periode donnee (demande explicite de l'utilisateur) - elle reste
 * visible dans n'importe quelle periode plutot que de ne plus etre
 * trouvable nulle part.
 */
function estDansPeriode(date: Date | null, bornes: { debut?: Date; fin?: Date } | undefined): boolean {
  if (!bornes) return true;
  if (!date) return true;
  if (bornes.debut && date < bornes.debut) return false;
  if (bornes.fin && date > bornes.fin) return false;
  return true;
}

export async function listerFacturesFournisseursUnifiees(
  prisma: PrismaClient,
  filtres: FiltresFacturesFournisseursUnifiees = {}
): Promise<ResultatFacturesFournisseursUnifiees> {
  // Le filtre de periode est applique en memoire (pas dans la requete
  // Prisma) : necessaire pour que les factures "a corriger" restent
  // TOUJOURS accessibles quelle que soit la periode (voir plus bas), et
  // pour qu'une date manquante/incorrecte ne masque jamais une facture
  // (estDansPeriode ci-dessus) - volumes reels (quelques centaines de
  // factures) largement dans les clous pour un filtrage en memoire, comme
  // le reste de cette fonction (recherche/fournisseurNom) le fait deja.
  const whereDocument: Prisma.DocumentFournisseurWhereInput = { type: "facture" };
  const whereArchive: Prisma.ArchiveComptableWhereInput = {
    // { origine: { not: "dext_copie" } } exclurait aussi, par semantique SQL
    // standard (NULL != x est inconnu, jamais vrai), les lignes anterieures
    // au marqueur (origine=NULL) qui doivent au contraire rester affichees -
    // voir le commentaire en tete de fichier. Forme explicite ci-dessous :
    // exclut uniquement une valeur exactement egale a "dext_copie".
    OR: [{ origine: null }, { origine: { not: "dext_copie" } }],
  };

  const [documents, archives] = await Promise.all([
    prisma.documentFournisseur.findMany({
      where: whereDocument,
      include: { fournisseur: { select: { nom: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.archiveComptable.findMany({
      where: whereArchive,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  let factures: FactureFournisseurUnifiee[] = [
    ...documents.map((d): FactureFournisseurUnifiee => {
      const { statut, detail } = statutDocumentFournisseur(d.statutDext);
      return {
        id: `document:${d.id}`,
        source: "document_fournisseur",
        sourceId: d.id,
        fournisseurNom: d.fournisseur?.nom ?? null,
        numero: d.numero,
        date: d.date ?? d.dateReceptionMail ?? null,
        montantHT: d.montantHT,
        montantTTC: d.montantTTC,
        statut,
        statutDetail: detail,
        fichierNom: d.fichierNom,
        mimeType: d.mimeType,
        rapprochementStatut: d.mouvementBancaireId ? "rapproche" : null,
        createdAt: d.createdAt,
      };
    }),
    ...archives.map((a): FactureFournisseurUnifiee => {
      const { statut, detail } = statutArchiveComptable(a.statut);
      return {
        id: `archive:${a.id}`,
        source: "archive_comptable",
        sourceId: a.id,
        fournisseurNom: a.fournisseurNom,
        numero: a.numero,
        date: a.dateFacture,
        montantHT: a.montantHT,
        montantTTC: a.montantTTC,
        statut,
        statutDetail: detail,
        fichierNom: a.fichierNom,
        mimeType: a.mimeType,
        rapprochementStatut: a.mouvementBancaireId ? "rapproche" : null,
        createdAt: a.createdAt,
      };
    }),
  ];

  if (filtres.fournisseurNom) {
    const recherche = filtres.fournisseurNom.toLowerCase();
    factures = factures.filter((f) => f.fournisseurNom?.toLowerCase().includes(recherche));
  }
  if (filtres.recherche) {
    const recherche = filtres.recherche.toLowerCase();
    factures = factures.filter(
      (f) =>
        f.fournisseurNom?.toLowerCase().includes(recherche) ||
        f.numero?.toLowerCase().includes(recherche) ||
        f.fichierNom?.toLowerCase().includes(recherche) ||
        String(f.montantTTC ?? "").includes(recherche)
    );
  }

  factures.sort((a, b) => (b.date?.getTime() ?? b.createdAt.getTime()) - (a.date?.getTime() ?? a.createdAt.getTime()));

  // "A corriger" (factures necessitant une intervention) reste TOUJOURS
  // accessible et compte sur l'integralite des donnees, quelle que soit la
  // periode choisie (demande explicite de l'utilisateur) - jamais filtre
  // par periode, ni dans son compteur ni dans sa propre liste.
  const bornesPeriode = resoudreBornesPeriode(filtres);
  const facturesPeriode = bornesPeriode ? factures.filter((f) => estDansPeriode(f.date, bornesPeriode)) : factures;

  const compteurs = {
    toutes: facturesPeriode.length,
    aTraiter: facturesPeriode.filter((f) => f.statut === "a_traiter").length,
    validees: facturesPeriode.filter((f) => f.statut === "validee").length,
    aCorriger: factures.filter((f) => f.statut === "a_corriger").length,
  };
  const montantTotalTTC = facturesPeriode.reduce((somme, f) => somme + (f.montantTTC ?? 0), 0);

  const facturesFiltreesParStatut =
    filtres.statut === "a_corriger"
      ? factures.filter((f) => f.statut === "a_corriger")
      : filtres.statut
        ? facturesPeriode.filter((f) => f.statut === filtres.statut)
        : facturesPeriode;

  const parPage = filtres.parPage && filtres.parPage > 0 ? filtres.parPage : PAR_PAGE_DEFAUT;
  const page = filtres.page && filtres.page > 0 ? filtres.page : 1;
  const debut = (page - 1) * parPage;
  const facturesPage = facturesFiltreesParStatut.slice(debut, debut + parPage);

  return {
    factures: facturesPage,
    total: facturesFiltreesParStatut.length,
    compteurs,
    montantTotalTTC,
    page,
    parPage,
  };
}

export interface ResultatReconciliationDoublonsHistoriques {
  examinees: number;
  reclassees: Array<{ archiveId: string; documentId: string; fournisseurNom: string | null; numero: string | null; montantTTC: number | null }>;
}

/**
 * Reclasse a posteriori (origine=NULL -> "dext_copie") les archives
 * anterieures a la migration 20261122160000_archive_comptable_origine qui
 * se revelent, avec CERTITUDE et non par hypothese, etre une copie d'un
 * DocumentFournisseur deja envoye a Dext - cas reel signale par
 * l'utilisateur (facture "e-Facture PA" / CFR00111626020513 affichee deux
 * fois dans l'ecran unifie). Critere de certitude : meme numero de facture
 * (identifiant cense etre unique chez un fournisseur donne) ET meme montant
 * TTC EXACT entre l'archive et le document - et, quand les deux noms de
 * fournisseur sont connus, ils doivent aussi correspondre (evite un faux
 * positif si deux fournisseurs differents partageaient par hasard le meme
 * numero). N'affecte jamais une archive dont l'origine est deja connue
 * (ovh_api/zip_manuel/dext_copie) ni une archive sans numero (trop faible
 * comme critere a lui seul).
 */
export async function reconcilierDoublonsHistoriquesDext(prisma: PrismaClient): Promise<ResultatReconciliationDoublonsHistoriques> {
  const [archivesNonClassees, documentsEnvoyes] = await Promise.all([
    prisma.archiveComptable.findMany({
      where: { origine: null, numero: { not: null } },
    }),
    prisma.documentFournisseur.findMany({
      where: { type: "facture", statutDext: { in: ["envoye", "archive"] }, numero: { not: null } },
      include: { fournisseur: { select: { nom: true } } },
    }),
  ]);

  const reclassees: ResultatReconciliationDoublonsHistoriques["reclassees"] = [];
  for (const archive of archivesNonClassees) {
    if (!archive.numero) continue;
    const correspondances = documentsEnvoyes.filter(
      (d) => d.numero === archive.numero && d.montantTTC != null && archive.montantTTC != null && Math.abs(d.montantTTC - archive.montantTTC) < 0.01
    );
    // Un seul document correspondant : jamais de choix arbitraire entre plusieurs candidats.
    if (correspondances.length !== 1) continue;
    const document = correspondances[0];
    const nomDocument = document.fournisseur?.nom ?? null;
    // Quand l'archive connait un nom de fournisseur, le document doit lui
    // aussi en avoir un resolu ET identique - un document sans fournisseur
    // resolu n'offre pas assez de certitude pour etre reconcilie sur le
    // seul numero+montant (jamais de reclassification devinee).
    if (archive.fournisseurNom) {
      if (!nomDocument) continue;
      if (nomDocument.toLowerCase().trim() !== archive.fournisseurNom.toLowerCase().trim()) continue;
    }

    await prisma.archiveComptable.update({
      where: { id: archive.id },
      data: { origine: "dext_copie", documentFournisseurId: document.id },
    });
    reclassees.push({ archiveId: archive.id, documentId: document.id, fournisseurNom: archive.fournisseurNom, numero: archive.numero, montantTTC: archive.montantTTC });
  }

  return { examinees: archivesNonClassees.length, reclassees };
}

export class FactureFournisseurUnifieeError extends Error {}

function decomposerId(id: string): { source: "document_fournisseur" | "archive_comptable"; sourceId: string } {
  const [prefixe, sourceId] = id.split(":");
  if (prefixe === "document" && sourceId) return { source: "document_fournisseur", sourceId };
  if (prefixe === "archive" && sourceId) return { source: "archive_comptable", sourceId };
  throw new FactureFournisseurUnifieeError(`Identifiant de facture invalide : ${id}`);
}

export interface DetailFactureFournisseurUnifiee extends FactureFournisseurUnifiee {
  fournisseurId: string | null;
  echeance: Date | null;
  categorie: string | null;
  classifiePar: string | null;
  gmailExpediteur: string | null;
  gmailObjet: string | null;
  dateReceptionMail: Date | null;
  historique: Array<{ date: Date; libelle: string }>;
}

/** Details complets d'une facture (panneau lateral) - jamais d'evenement invente : "historique" ne liste que des horodatages reellement connus. */
export async function obtenirDetailFactureFournisseurUnifiee(
  prisma: PrismaClient,
  id: string
): Promise<DetailFactureFournisseurUnifiee> {
  const { source, sourceId } = decomposerId(id);

  if (source === "document_fournisseur") {
    const d = await prisma.documentFournisseur.findUnique({
      where: { id: sourceId },
      include: { fournisseur: { select: { nom: true } } },
    });
    if (!d) throw new FactureFournisseurUnifieeError("Document introuvable.");
    const { statut, detail } = statutDocumentFournisseur(d.statutDext);
    const historique: Array<{ date: Date; libelle: string }> = [];
    if (d.dateReceptionMail) historique.push({ date: d.dateReceptionMail, libelle: `Reçue par e-mail${d.gmailExpediteur ? ` de ${d.gmailExpediteur}` : ""}` });
    historique.push({ date: d.createdAt, libelle: "Enregistrée dans Copilote Atelier Brochant" });
    if (statut === "validee") historique.push({ date: d.createdAt, libelle: detail });
    historique.sort((a, b) => a.date.getTime() - b.date.getTime());
    return {
      id,
      source,
      sourceId,
      fournisseurNom: d.fournisseur?.nom ?? null,
      fournisseurId: d.fournisseurId,
      numero: d.numero,
      date: d.date ?? d.dateReceptionMail ?? null,
      echeance: null,
      montantHT: d.montantHT,
      montantTTC: d.montantTTC,
      statut,
      statutDetail: detail,
      fichierNom: d.fichierNom,
      mimeType: d.mimeType,
      categorie: null,
      classifiePar: d.classifiePar,
      rapprochementStatut: d.mouvementBancaireId ? "rapproche" : null,
      gmailExpediteur: d.gmailExpediteur,
      gmailObjet: d.gmailObjet,
      dateReceptionMail: d.dateReceptionMail,
      createdAt: d.createdAt,
      historique,
    };
  }

  const a = await prisma.archiveComptable.findUnique({ where: { id: sourceId } });
  if (!a) throw new FactureFournisseurUnifieeError("Archive introuvable.");
  const { statut, detail } = statutArchiveComptable(a.statut);
  const historique: Array<{ date: Date; libelle: string }> = [
    { date: a.createdAt, libelle: a.origine === "ovh_api" ? "Synchronisée depuis OVHcloud" : "Importée dans l'archive comptable" },
  ];
  return {
    id,
    source,
    sourceId,
    fournisseurNom: a.fournisseurNom,
    fournisseurId: null,
    numero: a.numero,
    date: a.dateFacture,
    echeance: null,
    montantHT: a.montantHT,
    montantTTC: a.montantTTC,
    statut,
    statutDetail: detail,
    fichierNom: a.fichierNom,
    mimeType: a.mimeType,
    categorie: a.categorie,
    classifiePar: a.classifiePar,
    rapprochementStatut: a.mouvementBancaireId ? "rapproche" : null,
    gmailExpediteur: null,
    gmailObjet: null,
    dateReceptionMail: null,
    createdAt: a.createdAt,
    historique,
  };
}
