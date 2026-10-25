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

export type GranulariteCa = "jour" | "mois" | "annee";

export interface PointCa {
  /** "AAAA-MM-JJ" (jour), "AAAA-MM" (mois) ou "AAAA" (annee). */
  periode: string;
  montant: number;
}

/**
 * Cle de bucket a partir des composantes LOCALES de la date (jamais
 * toISOString, qui convertit en UTC et peut faire glisser la date d'un
 * jour selon le fuseau du serveur) : coherent avec le reste du fichier,
 * qui construit deja les buckets via setDate/setMonth en heure locale.
 */
function cleBucket(d: Date, granularite: GranulariteCa): string {
  const annee = String(d.getFullYear());
  const mois = String(d.getMonth() + 1).padStart(2, "0");
  const jour = String(d.getDate()).padStart(2, "0");
  if (granularite === "jour") return `${annee}-${mois}-${jour}`;
  if (granularite === "mois") return `${annee}-${mois}`;
  return annee;
}

/**
 * Serie temporelle du chiffre d'affaires (demande explicite de
 * l'utilisateur : "pouvoir regarder mon chiffre d'affaires par jour ou par
 * mois ou par annee"), pour le graphique du tableau de bord. Memes donnees
 * que caVeille (Facture.dateEmission x montantTTC), simplement agregees
 * sur une fenetre glissante plutot qu'un seul jour.
 *
 * Les buckets sans facture sont explicitement a zero (pas absents) : une
 * courbe avec des trous au lieu de creux a zero serait trompeuse.
 */
export async function getCaSerieTemporelle(
  prisma: PrismaClient,
  granularite: GranulariteCa,
  maintenant: Date = new Date()
): Promise<PointCa[]> {
  const fin = startOfDay(maintenant);
  const debut = new Date(fin);
  const buckets: string[] = [];

  if (granularite === "jour") {
    debut.setDate(debut.getDate() - 29);
    for (let i = 0; i < 30; i++) {
      const d = new Date(debut);
      d.setDate(d.getDate() + i);
      buckets.push(cleBucket(d, "jour"));
    }
  } else if (granularite === "mois") {
    debut.setMonth(debut.getMonth() - 11, 1);
    for (let i = 0; i < 12; i++) {
      const d = new Date(debut);
      d.setMonth(d.getMonth() + i, 1);
      buckets.push(cleBucket(d, "mois"));
    }
  } else {
    debut.setFullYear(debut.getFullYear() - 4, 0, 1);
    for (let i = 0; i < 5; i++) {
      const d = new Date(debut);
      d.setFullYear(d.getFullYear() + i, 0, 1);
      buckets.push(cleBucket(d, "annee"));
    }
  }

  const factures = await prisma.facture.findMany({
    where: { dateEmission: { gte: debut } },
    select: { dateEmission: true, montantTTC: true },
  });

  const totaux = new Map<string, number>();
  for (const f of factures) {
    if (!f.dateEmission) continue; // exclu par le where ci-dessus, garde-fou de type uniquement
    const cle = cleBucket(f.dateEmission, granularite);
    totaux.set(cle, (totaux.get(cle) || 0) + f.montantTTC);
  }

  return buckets.map((periode) => ({ periode, montant: totaux.get(periode) || 0 }));
}

/**
 * Construit le resume du cockpit quotidien (section 9.1) a partir des
 * donnees deja recues par imports CSV : CA de la veille et impayes, comme
 * demande explicitement par le critere d'acceptation V1 correspondant.
 *
 * `maintenant` est injectable (par defaut l'heure reelle) pour que les
 * tests fixent une date de reference independante du jour ou ils sont
 * rejoues, plutot que de dependre de l'horloge systeme au moment du test.
 */
export async function getDashboardSummary(prisma: PrismaClient, maintenant: Date = new Date()): Promise<DashboardSummary> {
  const today = startOfDay(maintenant);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const facturesVeille = await prisma.facture.findMany({
    where: { dateEmission: { gte: yesterday, lt: today } },
    select: { montantTTC: true },
  });
  const caVeille = facturesVeille.reduce((sum, f) => sum + f.montantTTC, 0);

  // "Impaye" couvre aussi les factures partiellement reglees : c'est le
  // reste a percevoir (montantTTC - montantRegle) qui compte, pas la
  // presence d'un statut binaire.
  const impayees = await prisma.facture.findMany({
    where: { statut: { in: ["impayee", "partiellement_payee"] } },
    select: { montantTTC: true, montantRegle: true },
  });
  const montantImpayes = impayees.reduce((sum, f) => sum + (f.montantTTC - f.montantRegle), 0);

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
