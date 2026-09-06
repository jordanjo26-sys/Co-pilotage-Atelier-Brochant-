import { Facture, PrismaClient } from "@prisma/client";
import { deriveStatut } from "../importers/synecFactures";
import { logEvenement } from "./journalService";

/**
 * « Un bon de commande payé par Stripe est reconnu comme payé ; un bon de
 * commande non payé peut bénéficier du délai de 30 jours » (section 4.4,
 * critere d'acceptation V1 — jusqu'ici hors perimetre, cf.
 * docs/criteres-acceptation.md).
 *
 * Deux volets, tous deux deterministes (section 14, jamais de supposition) :
 *  1. Un paiement Stripe dont la description cite la reference du bon de
 *     commande (et une seule facture concernee) marque cette facture payee.
 *  2. A defaut, une facture avec bon de commande beneficie d'un delai de
 *     grace de 30 jours a compter de son emission (reutilise le meme
 *     mecanisme que le "delai accorde" manuel, section 4.3 : suspend les
 *     relances sans introduire un nouvel etat).
 */

const JOURS_DELAI_BON_COMMANDE = 30;

export interface ResultatVerificationBonsCommande {
  facturesPayees: number;
  facturesAmbigues: number;
  delaisAccordes: number;
}

function ajouterJours(date: Date, jours: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + jours);
  return d;
}

/**
 * Recherche, parmi les paiements Stripe pas encore rattaches a une facture,
 * ceux dont la description contient la reference du bon de commande. Une
 * seule correspondance est exigee : plusieurs paiements evoquant la meme
 * reference restent ambigus (jamais de choix devine entre plusieurs).
 */
async function trouverPaiementCorrespondant(prisma: PrismaClient, bonCommande: string) {
  const candidats = await prisma.paiement.findMany({
    where: {
      factureId: null,
      source: "stripe",
      description: { contains: bonCommande, mode: "insensitive" },
    },
  });
  return candidats;
}

async function traiterFacture(prisma: PrismaClient, facture: Facture, maintenant: Date): Promise<"payee" | "ambigue" | "delai_accorde" | "rien"> {
  const bonCommande = facture.bonCommande;
  if (!bonCommande) return "rien";

  const candidats = await trouverPaiementCorrespondant(prisma, bonCommande);

  if (candidats.length === 1) {
    const paiement = candidats[0];
    const nouveauMontantRegle = facture.montantRegle + paiement.brut;
    const nouveauStatut = deriveStatut(facture.montantTTC, nouveauMontantRegle);

    await prisma.$transaction([
      prisma.paiement.update({ where: { id: paiement.id }, data: { factureId: facture.id } }),
      prisma.facture.update({ where: { id: facture.id }, data: { montantRegle: nouveauMontantRegle, statut: nouveauStatut } }),
    ]);

    await logEvenement(prisma, {
      evenement: "bon_commande_paye",
      action: `Bon de commande "${bonCommande}" (facture ${facture.reference}) rapproche d'un paiement Stripe`,
      resultat: `${paiement.brut.toFixed(2)} EUR - nouveau statut : ${nouveauStatut}.`,
    });
    return nouveauStatut === "payee" ? "payee" : "rien";
  }

  if (candidats.length > 1) {
    // Ambigu : plusieurs paiements Stripe citent la meme reference (ex. un
    // bon de commande partiellement regle en plusieurs fois, ou une
    // reference reutilisee par erreur) - jamais de choix devine, laisse
    // pour verification manuelle.
    return "ambigue";
  }

  // Aucun paiement trouve pour l'instant : delai de grace de 30 jours a
  // compter de l'emission (jamais ecrase si deja fixe par ailleurs, jamais
  // recalcule a partir d'"aujourd'hui" - la date cible est fixe, basee sur
  // une donnee immuable, pour rester idempotent d'un passage a l'autre).
  if (facture.delaiAccordeJusqua || !facture.dateEmission) return "rien";
  const dateLimite = ajouterJours(facture.dateEmission, JOURS_DELAI_BON_COMMANDE);
  if (dateLimite <= maintenant) return "rien"; // delai deja ecoule, inutile de le fixer

  await prisma.facture.update({ where: { id: facture.id }, data: { delaiAccordeJusqua: dateLimite } });
  await logEvenement(prisma, {
    evenement: "bon_commande_delai_accorde",
    action: `Delai de 30 jours accorde a la facture ${facture.reference} (bon de commande "${bonCommande}")`,
    resultat: `Relances suspendues jusqu'au ${dateLimite.toLocaleDateString("fr-FR")}, en l'absence de paiement Stripe correspondant.`,
  });
  return "delai_accorde";
}

/**
 * Verifie toutes les factures avec bon de commande encore impayees (ou
 * partiellement payees). Idempotent : peut etre rejouee sans consequence,
 * y compris apres chaque synchronisation Stripe.
 */
export async function verifierBonsCommande(prisma: PrismaClient, maintenant: Date = new Date()): Promise<ResultatVerificationBonsCommande> {
  const factures = await prisma.facture.findMany({
    where: { bonCommande: { not: null }, statut: { in: ["impayee", "partiellement_payee"] } },
  });

  const resultat: ResultatVerificationBonsCommande = { facturesPayees: 0, facturesAmbigues: 0, delaisAccordes: 0 };
  for (const facture of factures) {
    const issue = await traiterFacture(prisma, facture, maintenant);
    if (issue === "payee") resultat.facturesPayees++;
    else if (issue === "ambigue") resultat.facturesAmbigues++;
    else if (issue === "delai_accorde") resultat.delaisAccordes++;
  }

  return resultat;
}
