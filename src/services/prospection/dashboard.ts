import { PrismaClient } from "@prisma/client";

/**
 * Tableau de bord de suivi (section 2.5 du cahier des charges prospection) :
 * repartition des prospects par statut, taux d'ouverture/reponse par
 * campagne, historique des envois.
 */

export interface StatutCompte {
  statut: string;
  nombre: number;
}

export interface CampagneStats {
  campagneId: string;
  nom: string;
  statut: string;
  nbEnvois: number;
  nbOuverts: number;
  nbCliques: number;
  nbRepondus: number;
  nbRebonds: number;
  nbDesabonnes: number;
  tauxOuverture: number;
  tauxReponse: number;
}

export async function repartitionParStatut(prisma: PrismaClient): Promise<StatutCompte[]> {
  const groupes = await prisma.prospect.groupBy({ by: ["statut"], _count: { statut: true } });
  return groupes.map((g) => ({ statut: g.statut, nombre: g._count.statut }));
}

export async function statistiquesCampagnes(prisma: PrismaClient): Promise<CampagneStats[]> {
  const campagnes = await prisma.campagne.findMany({
    include: { envois: true },
    orderBy: { createdAt: "desc" },
  });

  return campagnes.map((c) => {
    const nbEnvois = c.envois.length;
    const compte = (statuts: string[]) => c.envois.filter((e) => statuts.includes(e.statut)).length;
    const nbOuverts = c.envois.filter((e) => e.dateOuverture).length;
    const nbCliques = c.envois.filter((e) => e.dateClic).length;
    const nbRepondus = compte(["repondu"]);
    const nbRebonds = compte(["rebond"]);
    const nbDesabonnes = compte(["desabonne"]);

    return {
      campagneId: c.id,
      nom: c.nom,
      statut: c.statut,
      nbEnvois,
      nbOuverts,
      nbCliques,
      nbRepondus,
      nbRebonds,
      nbDesabonnes,
      tauxOuverture: nbEnvois > 0 ? Math.round((nbOuverts / nbEnvois) * 100) : 0,
      tauxReponse: nbEnvois > 0 ? Math.round((nbRepondus / nbEnvois) * 100) : 0,
    };
  });
}

export interface HistoriqueEnvoi {
  id: string;
  campagneNom: string;
  prospectEntreprise: string;
  statut: string;
  estRelance: boolean;
  dateEnvoi: string;
}

export async function historiqueEnvois(prisma: PrismaClient, limite = 200): Promise<HistoriqueEnvoi[]> {
  const envois = await prisma.envoiCampagne.findMany({
    include: { campagne: true, prospect: true },
    orderBy: { dateEnvoi: "desc" },
    take: limite,
  });

  return envois.map((e) => ({
    id: e.id,
    campagneNom: e.campagne.nom,
    prospectEntreprise: e.prospect.entreprise,
    statut: e.statut,
    estRelance: e.estRelance,
    dateEnvoi: e.dateEnvoi.toISOString(),
  }));
}
