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
 */

// Un virement Stripe initie a la date du payout arrive generalement sur le
// compte bancaire sous 1 a 3 jours ouvres ; la fenetre est volontairement
// un peu plus large pour absorber les week-ends/jours feries.
const FENETRE_JOURS = 5;
const TOLERANCE_MONTANT = 0.01; // arrondi centime

export interface ResultatRapprochement {
  nbRapproches: number;
  nbAmbigus: number;
  nbSansCorrespondance: number;
  details: Array<{ payoutRef: string; resultat: "rapproche" | "ambigu" | "sans_correspondance"; mouvementId?: string }>;
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
  const [payoutsAtraiter, mouvementsDisponibles] = await Promise.all([
    prisma.payout.findMany({ where: { mouvementBancaireId: null } }),
    prisma.mouvementBancaire.findMany({ where: { rapprochementStatut: "non_rapproche" } }),
  ]);

  const resultat: ResultatRapprochement = { nbRapproches: 0, nbAmbigus: 0, nbSansCorrespondance: 0, details: [] };
  // Un mouvement deja affecte au cours de cette meme execution ne doit pas
  // etre propose une seconde fois a un autre payout.
  const dejaUtilises = new Set<string>();

  for (const payout of payoutsAtraiter) {
    const candidats = mouvementsDisponibles.filter(
      (m) =>
        !dejaUtilises.has(m.id) &&
        Math.abs(m.montant - payout.montantNet) < TOLERANCE_MONTANT &&
        differenceJours(m.date, payout.date) <= FENETRE_JOURS
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

  if (resultat.nbRapproches > 0 || resultat.nbAmbigus > 0) {
    await logEvenement(prisma, {
      evenement: "rapprochement_bancaire",
      action: "Rapprochement automatique payouts <-> mouvements bancaires",
      resultat: `${resultat.nbRapproches} rapproche(s), ${resultat.nbAmbigus} ambigu(s) (plusieurs mouvements candidats), ${resultat.nbSansCorrespondance} sans mouvement correspondant pour l'instant.`,
    });
  }

  return resultat;
}
