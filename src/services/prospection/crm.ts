import { Prisma, PrismaClient } from "@prisma/client";

/**
 * Mini-CRM (section 2.2 du cahier des charges prospection) : consultation
 * et mise a jour des fiches prospects, avec historique des changements de
 * statut.
 */

export const STATUTS_PROSPECT = ["a_contacter", "contacte", "relance", "rdv", "client", "sans_suite"] as const;

export interface FiltreProspects {
  type?: string;
  statut?: string;
  marqueProposee?: string;
  codePostal?: string;
  recherche?: string; // entreprise/contact
}

export async function listerProspects(prisma: PrismaClient, filtre: FiltreProspects = {}) {
  const where: Prisma.ProspectWhereInput = {};
  if (filtre.type) where.type = filtre.type;
  if (filtre.statut) where.statut = filtre.statut;
  if (filtre.marqueProposee) where.marqueProposee = filtre.marqueProposee;
  if (filtre.codePostal) where.codePostal = { startsWith: filtre.codePostal };
  if (filtre.recherche) {
    where.OR = [
      { entreprise: { contains: filtre.recherche, mode: "insensitive" } },
      { contactNom: { contains: filtre.recherche, mode: "insensitive" } },
    ];
  }

  return prisma.prospect.findMany({ where, orderBy: { updatedAt: "desc" }, take: 1000 });
}

export async function obtenirProspect(prisma: PrismaClient, id: string) {
  return prisma.prospect.findUnique({
    where: { id },
    include: {
      historiqueStatuts: { orderBy: { createdAt: "desc" } },
      envois: { include: { campagne: true }, orderBy: { dateEnvoi: "desc" } },
    },
  });
}

export interface MiseAJourProspect {
  contactNom?: string;
  contactFonction?: string;
  email?: string;
  telephone?: string;
  adresse?: string;
  codePostal?: string;
  ville?: string;
  marqueProposee?: string;
  serviceCible?: string;
  notes?: string;
  dateDerniereRelance?: string;
}

export async function modifierProspect(prisma: PrismaClient, id: string, data: MiseAJourProspect) {
  return prisma.prospect.update({
    where: { id },
    data: {
      ...data,
      dateDerniereRelance: data.dateDerniereRelance ? new Date(data.dateDerniereRelance) : undefined,
    },
  });
}

/** Changement de statut manuel (section 2.2 : "avec historique des changements"). */
export async function changerStatutProspect(prisma: PrismaClient, id: string, nouveauStatut: string, auteur?: string) {
  if (!STATUTS_PROSPECT.includes(nouveauStatut as (typeof STATUTS_PROSPECT)[number])) {
    throw new Error(`Statut inconnu : "${nouveauStatut}".`);
  }

  const prospect = await prisma.prospect.findUniqueOrThrow({ where: { id } });
  if (prospect.statut === nouveauStatut) return prospect;

  await prisma.prospectStatutChangement.create({
    data: { prospectId: id, ancienStatut: prospect.statut, nouveauStatut, auteur: auteur || "manuel" },
  });

  const data: Prisma.ProspectUpdateInput = { statut: nouveauStatut };
  if (nouveauStatut === "contacte" && !prospect.datePremierContact) data.datePremierContact = new Date();

  return prisma.prospect.update({ where: { id }, data });
}

export async function supprimerProspect(prisma: PrismaClient, id: string) {
  await prisma.prospectStatutChangement.deleteMany({ where: { prospectId: id } });
  await prisma.envoiCampagne.deleteMany({ where: { prospectId: id } });
  await prisma.prospect.delete({ where: { id } });
}
