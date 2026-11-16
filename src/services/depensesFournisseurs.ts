import { PrismaClient } from "@prisma/client";

/**
 * Dépenses par fournisseur, par jour/mois/année (demande explicite de
 * l'utilisateur : "connaître mes dépenses chez les fournisseurs... pour
 * savoir ce que représente les dépenses autour de l'année"). Fondé sur
 * DocumentFournisseur.montant (type "facture" uniquement - une dépense
 * réelle, ni un devis ni un bon d'enlèvement), rempli soit
 * automatiquement à la réception (extraireMontantFacture, voir
 * gmailClassify.ts), soit par saisie manuelle (voir
 * saisirMontantDocumentFournisseur dans fournisseurs.ts) quand
 * l'extraction automatique échoue.
 *
 * Regroupé en JavaScript plutôt qu'en SQL brut (GROUP BY avec troncature
 * de date) : le volume de factures fournisseurs reste modeste, et ça évite
 * toute requête spécifique à un moteur de base de données précis.
 */

export type GranulariteDepense = "jour" | "mois" | "annee";

export interface DepensePeriode {
  fournisseurId: string | null;
  fournisseurNom: string;
  periode: string; // "2026-11-16" | "2026-11" | "2026" selon la granularité
  total: number;
  nombreFactures: number;
  nombreSansMontant: number; // factures du type "facture" sans montant renseigné sur cette période - le total ci-dessus est alors incomplet
}

function cleDePeriode(date: Date, granularite: GranulariteDepense): string {
  const annee = date.getFullYear();
  const mois = String(date.getMonth() + 1).padStart(2, "0");
  const jour = String(date.getDate()).padStart(2, "0");
  if (granularite === "jour") return `${annee}-${mois}-${jour}`;
  if (granularite === "mois") return `${annee}-${mois}`;
  return String(annee);
}

export async function obtenirDepensesFournisseurs(
  prisma: PrismaClient,
  params: { granularite: GranulariteDepense; debut?: Date; fin?: Date }
): Promise<DepensePeriode[]> {
  const documents = await prisma.documentFournisseur.findMany({
    where: {
      type: "facture",
      dateReceptionMail: {
        ...(params.debut ? { gte: params.debut } : {}),
        ...(params.fin ? { lte: params.fin } : {}),
      },
    },
    include: { fournisseur: { select: { nom: true } } },
  });

  const groupes = new Map<string, DepensePeriode>();
  for (const doc of documents) {
    const date = doc.dateReceptionMail || doc.createdAt;
    const periode = cleDePeriode(date, params.granularite);
    const fournisseurNom = doc.fournisseur?.nom || doc.gmailExpediteur || "Expéditeur inconnu";
    const cle = `${doc.fournisseurId ?? "aucun"}|${periode}`;

    let groupe = groupes.get(cle);
    if (!groupe) {
      groupe = { fournisseurId: doc.fournisseurId, fournisseurNom, periode, total: 0, nombreFactures: 0, nombreSansMontant: 0 };
      groupes.set(cle, groupe);
    }
    groupe.nombreFactures++;
    if (doc.montant != null) groupe.total += doc.montant;
    else groupe.nombreSansMontant++;
  }

  return Array.from(groupes.values()).sort((a, b) => (a.periode === b.periode ? b.total - a.total : a.periode.localeCompare(b.periode)));
}
