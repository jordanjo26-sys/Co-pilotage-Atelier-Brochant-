import { PrismaClient } from "@prisma/client";

/**
 * Rapprochement automatique paiement Stripe <-> facture client, pour
 * afficher le nom du client et le numéro de facture à côté de chaque
 * paiement (demande explicite de l'utilisateur). Même niveau de rigueur
 * que le rapprochement bancaire payout <-> mouvement (rapprochementBancaire.ts,
 * section 14 : jamais de supposition). Deux methodes, essayees dans l'ordre :
 *
 * 1. Identifiant PaymentIntent Stripe exact ("pi_...") : Synec note deja
 *    cette reference dans sa colonne "payments" quand le reglement vient de
 *    Stripe (voir parseReglements/Facture.referencesStripe), et la synchro
 *    Stripe directe la recupere aussi (Paiement.paymentIntentRef) - une
 *    simple egalite d'identifiant suffit, aucune ambiguite possible.
 * 2. A defaut (paiement sans correspondance exacte, ex. importe par CSV ou
 *    facture sans mention Stripe dans Synec) : la description Stripe du
 *    paiement cite, sans ambiguite, la reference ou le bon de commande
 *    d'une seule facture.
 *
 * Dans les deux cas, plusieurs candidats (ou aucun) laissent le paiement
 * non rattaché plutôt qu'un rattachement au hasard.
 *
 * N'influence JAMAIS le statut payée/impayée d'une facture (qui vient
 * exclusivement du champ "règlements" de l'export Synec) : un rattachement
 * ici n'est qu'une information d'affichage, pas une écriture comptable.
 */

export interface ResultatRapprochementFactures {
  nbRapproches: number;
  nbAmbigus: number;
  nbSansCorrespondance: number;
}

// Evite qu'une reference courte ("FACTURE-180") corresponde a tort a
// l'interieur d'une reference plus longue qui la contient ("FACTURE-1807") :
// la correspondance n'est retenue que si elle n'est pas immediatement
// entouree d'un autre caractere alphanumerique.
function referencePresente(texte: string, reference: string): boolean {
  const motif = reference.trim();
  if (!motif) return false;
  const echappe = motif.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${echappe}(?![a-z0-9])`, "i").test(texte);
}

/**
 * Tente de rattacher chaque paiement Stripe pas encore relie a une facture.
 * Idempotent : ne fait rien pour un paiement deja rattache, ni pour un
 * paiement sans aucune piste (ni paymentIntentRef, ni description) - peut
 * etre rejoue autant de fois que necessaire (par ex. apres chaque nouvelle
 * synchronisation Stripe ou import de factures Synec).
 */
export async function rapprocherPaiementsFactures(prisma: PrismaClient): Promise<ResultatRapprochementFactures> {
  const [paiementsAtraiter, factures] = await Promise.all([
    prisma.paiement.findMany({
      where: { factureId: null, OR: [{ description: { not: null } }, { paymentIntentRef: { not: null } }] },
    }),
    prisma.facture.findMany({ select: { id: true, reference: true, bonCommande: true, referencesStripe: true } }),
  ]);

  const resultat: ResultatRapprochementFactures = { nbRapproches: 0, nbAmbigus: 0, nbSansCorrespondance: 0 };

  for (const paiement of paiementsAtraiter) {
    let candidats = paiement.paymentIntentRef
      ? factures.filter((f) => f.referencesStripe?.split(",").includes(paiement.paymentIntentRef!))
      : [];

    // Pas de correspondance exacte (ou pas de paymentIntentRef du tout) :
    // repli sur la description (reference/bon de commande).
    if (candidats.length === 0 && paiement.description) {
      const texte = paiement.description;
      candidats = factures.filter(
        (f) => referencePresente(texte, f.reference) || (f.bonCommande && referencePresente(texte, f.bonCommande))
      );
    }

    if (candidats.length === 1) {
      await prisma.paiement.update({ where: { id: paiement.id }, data: { factureId: candidats[0].id } });
      resultat.nbRapproches++;
    } else if (candidats.length > 1) {
      resultat.nbAmbigus++;
    } else {
      resultat.nbSansCorrespondance++;
    }
  }

  return resultat;
}
