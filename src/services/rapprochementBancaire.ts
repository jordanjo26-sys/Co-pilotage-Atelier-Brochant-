import { PrismaClient } from "@prisma/client";
import { logEvenement } from "./journalService";

/**
 * Rapprochement automatique payout Stripe <-> mouvement bancaire (section 5
 * du cahier des charges, Phase 5 "moteur de regles").
 *
 * Contrairement aux relances (contact d'un tiers, donc geste humain
 * volontaire par prudence), ce rapprochement est une ecriture purement
 * interne de comptabilite - au meme niveau de confiance que le
 * rattachement automatique d'une facture a son client par nom
 * (synecFactures.ts) : aucune raison de le retenir pour validation
 * humaine quand la correspondance est certaine.
 *
 * "Certaine" est defini strictement (section 14, jamais de supposition) :
 * un seul mouvement bancaire au montant exactement identique dans une
 * fenetre de quelques jours autour de la date du payout. En cas de
 * plusieurs candidats (montants identiques a des dates proches, ex.
 * plusieurs payouts du meme montant la meme semaine), rien n'est
 * rapproche automatiquement - le payout reste signale "ambigu" pour un
 * choix manuel plutot qu'un rapprochement au hasard.
 *
 * Demande explicite de l'utilisateur ("rapprochement au Comptable") :
 * couvrir aussi les factures fournisseurs, pas seulement les payouts
 * Stripe, pour constituer un dossier comptable complet (voir
 * dossierComptable.ts) plutot qu'une simple verification cote
 * encaissements.
 */

// Un virement Stripe initie a la date du payout arrive generalement sur le
// compte bancaire sous 1 a 3 jours ouvres ; la fenetre est volontairement
// un peu plus large pour absorber les week-ends/jours feries.
const FENETRE_JOURS_PAYOUT = 5;
// Une facture fournisseur peut etre payee avant l'echeance (prelevement
// anticipe) ou apres (retard) : fenetre volontairement plus large que pour
// les payouts, dont la date est precise. La securite vient toujours de
// l'unicite du montant dans cette fenetre, pas de sa largeur - un montant
// ambigu reste "ambigu".
const FENETRE_JOURS_FACTURE_FOURNISSEUR = 20;
const TOLERANCE_MONTANT = 0.01; // arrondi centime

export interface ResultatRapprochement {
  nbRapproches: number;
  nbAmbigus: number;
  nbSansCorrespondance: number;
  nbRapprochesFournisseurs: number;
  nbAmbigusFournisseurs: number;
  nbSansCorrespondanceFournisseurs: number;
  details: Array<{ payoutRef: string; resultat: "rapproche" | "ambigu" | "sans_correspondance"; mouvementId?: string }>;
  detailsFournisseurs: Array<{
    factureId: string;
    reference: string | null;
    resultat: "rapproche" | "ambigu" | "sans_correspondance";
    mouvementId?: string;
  }>;
}

function differenceJours(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Tente de rapprocher chaque payout Stripe pas encore relie a un mouvement
 * bancaire. Idempotent : ne fait rien pour un payout deja rapproche, peut
 * etre rejoue autant de fois que necessaire (par ex. apres chaque nouvel
 * import de payouts ou de releve bancaire).
 */
export async function executerRapprochementBancaire(prisma: PrismaClient): Promise<ResultatRapprochement> {
  const resultat: ResultatRapprochement = {
    nbRapproches: 0,
    nbAmbigus: 0,
    nbSansCorrespondance: 0,
    nbRapprochesFournisseurs: 0,
    nbAmbigusFournisseurs: 0,
    nbSansCorrespondanceFournisseurs: 0,
    details: [],
    detailsFournisseurs: [],
  };
  // Un mouvement deja affecte au cours de cette meme execution (payout ou
  // facture fournisseur) ne doit pas etre propose une seconde fois.
  const dejaUtilises = new Set<string>();

  // --- Payouts Stripe (credit) ---------------------------------------
  const [payoutsAtraiter, mouvementsCredit] = await Promise.all([
    prisma.payout.findMany({ where: { mouvementBancaireId: null } }),
    prisma.mouvementBancaire.findMany({ where: { rapprochementStatut: "non_rapproche" } }),
  ]);

  for (const payout of payoutsAtraiter) {
    const candidats = mouvementsCredit.filter(
      (m) =>
        !dejaUtilises.has(m.id) &&
        Math.abs(m.montant - payout.montantNet) < TOLERANCE_MONTANT &&
        differenceJours(m.date, payout.date) <= FENETRE_JOURS_PAYOUT
    );

    if (candidats.length === 1) {
      const mouvement = candidats[0];
      await prisma.$transaction([
        prisma.payout.update({ where: { id: payout.id }, data: { mouvementBancaireId: mouvement.id } }),
        prisma.mouvementBancaire.update({ where: { id: mouvement.id }, data: { rapprochementStatut: "rapproche" } }),
      ]);
      dejaUtilises.add(mouvement.id);
      resultat.nbRapproches++;
      resultat.details.push({ payoutRef: payout.payoutRef, resultat: "rapproche", mouvementId: mouvement.id });
    } else if (candidats.length > 1) {
      resultat.nbAmbigus++;
      resultat.details.push({ payoutRef: payout.payoutRef, resultat: "ambigu" });
    } else {
      resultat.nbSansCorrespondance++;
      resultat.details.push({ payoutRef: payout.payoutRef, resultat: "sans_correspondance" });
    }
  }

  // --- Factures fournisseurs (debit) ----------------------------------
  // Mouvements encore "non_rapproche" apres la passe payouts ci-dessus,
  // et effectivement des debits (le solde d'une facture fournisseur part
  // du compte, jamais n'y arrive) - un debit a montant 0 ne peut etre un
  // candidat (ligne purement creditrice).
  const [facturesAtraiter, mouvementsDebit] = await Promise.all([
    prisma.factureFournisseur.findMany({ where: { statut: "a_payer", mouvementBancaireId: null } }),
    prisma.mouvementBancaire.findMany({ where: { rapprochementStatut: "non_rapproche", debit: { gt: 0 } } }),
  ]);

  for (const facture of facturesAtraiter) {
    if (facture.echeance === null) {
      // Pas de date de reference exploitable : jamais de rapprochement a
      // l'aveugle sur le montant seul (section 14).
      resultat.nbSansCorrespondanceFournisseurs++;
      resultat.detailsFournisseurs.push({ factureId: facture.id, reference: facture.reference, resultat: "sans_correspondance" });
      continue;
    }
    const candidats = mouvementsDebit.filter(
      (m) =>
        !dejaUtilises.has(m.id) &&
        Math.abs(m.debit - facture.montant) < TOLERANCE_MONTANT &&
        differenceJours(m.date, facture.echeance as Date) <= FENETRE_JOURS_FACTURE_FOURNISSEUR
    );

    if (candidats.length === 1) {
      const mouvement = candidats[0];
      await prisma.$transaction([
        prisma.factureFournisseur.update({
          where: { id: facture.id },
          data: { mouvementBancaireId: mouvement.id, statut: "payee" },
        }),
        prisma.mouvementBancaire.update({ where: { id: mouvement.id }, data: { rapprochementStatut: "rapproche" } }),
      ]);
      dejaUtilises.add(mouvement.id);
      resultat.nbRapprochesFournisseurs++;
      resultat.detailsFournisseurs.push({ factureId: facture.id, reference: facture.reference, resultat: "rapproche", mouvementId: mouvement.id });
    } else if (candidats.length > 1) {
      resultat.nbAmbigusFournisseurs++;
      resultat.detailsFournisseurs.push({ factureId: facture.id, reference: facture.reference, resultat: "ambigu" });
    } else {
      resultat.nbSansCorrespondanceFournisseurs++;
      resultat.detailsFournisseurs.push({ factureId: facture.id, reference: facture.reference, resultat: "sans_correspondance" });
    }
  }

  if (resultat.nbRapproches > 0 || resultat.nbAmbigus > 0 || resultat.nbRapprochesFournisseurs > 0 || resultat.nbAmbigusFournisseurs > 0) {
    await logEvenement(prisma, {
      evenement: "rapprochement_bancaire",
      action: "Rapprochement automatique payouts/factures fournisseurs <-> mouvements bancaires",
      resultat: `Payouts : ${resultat.nbRapproches} rapproche(s), ${resultat.nbAmbigus} ambigu(s), ${resultat.nbSansCorrespondance} sans correspondance. Factures fournisseurs : ${resultat.nbRapprochesFournisseurs} rapprochee(s), ${resultat.nbAmbigusFournisseurs} ambigue(s), ${resultat.nbSansCorrespondanceFournisseurs} sans correspondance.`,
    });
  }

  return resultat;
}
