import { PrismaClient } from "@prisma/client";

export interface DashboardSummary {
  caVeille: number;
  dateVeille: string;
  impayes: { nombre: number; montantTotal: number };
  aValiderImports: number;
  anomaliesOuvertes: number;
  dernierImport: { fichierNom: string; dateImport: string; statut: string } | null;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Construit le resume du cockpit quotidien (section 9.1) a partir des
 * donnees deja recues par imports CSV : CA de la veille et impayes, comme
 * demande explicitement par le critere d'acceptation V1 correspondant.
 */
export async function getDashboardSummary(prisma: PrismaClient): Promise<DashboardSummary> {
  const today = startOfDay(new Date());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const facturesVeille = await prisma.facture.findMany({
    where: { dateEmission: { gte: yesterday, lt: today } },
    select: { montantTTC: true },
  });
  const caVeille = facturesVeille.reduce((sum, f) => sum + f.montantTTC, 0);

  const impayees = await prisma.facture.findMany({
    where: { statut: "impayee" },
    select: { montantTTC: true },
  });
  const montantImpayes = impayees.reduce((sum, f) => sum + f.montantTTC, 0);

  const aValiderImports = await prisma.importBatch.count({
    where: { statut: { in: ["type_inconnu", "partiel", "echec"] } },
  });

  const anomaliesOuvertes = await prisma.anomalie.count({ where: { statut: "a_valider" } });

  const dernier = await prisma.importBatch.findFirst({ orderBy: { dateImport: "desc" } });

  return {
    caVeille,
    dateVeille: yesterday.toISOString().slice(0, 10),
    impayes: { nombre: impayees.length, montantTotal: montantImpayes },
    aValiderImports,
    anomaliesOuvertes,
    dernierImport: dernier
      ? { fichierNom: dernier.fichierNom, dateImport: dernier.dateImport.toISOString(), statut: dernier.statut }
      : null,
  };
}
