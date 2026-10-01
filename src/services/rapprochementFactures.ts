import { PrismaClient } from "@prisma/client";

/**
 * Rapprochement automatique paiement Stripe <-> facture client, pour
 * afficher le nom du client et le numéro de facture à côté de chaque
 * paiement (demande explicite de l'utilisateur). Même niveau de rigueur
 * que le rapprochement bancaire payout <-> mouvement (rapprochementBancaire.ts,
 * section 14 : jamais de supposition) : un paiement n'est rattaché à une
 * facture que si sa description Stripe cite, sans ambiguïté possible, la
 * référence ou le bon de commande d'une seule facture. Plusieurs candidats
 * (ou aucun) laissent le paiement non rattaché plutôt qu'un rattachement au
 * hasard.
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
 * Idempotent : ne fait rien pour un paiement deja rattache ou sans
 * description, peut etre rejoue autant de fois que necessaire (par ex.
 * apres chaque nouvelle synchronisation Stripe ou Synec).
 */
export async function rapprocherPaiementsFactures(prisma: PrismaClient): Promise<ResultatRapprochementFactures> {
  const [paiementsAtraiter, factures] = await Promise.all([
    prisma.paiement.findMany({ where: { factureId: null, description: { not: null } } }),
    prisma.facture.findMany({ select: { id: true, reference: true, bonCommande: true } }),
  ]);

  const resultat: ResultatRapprochementFactures = { nbRapproches: 0, nbAmbigus: 0, nbSansCorrespondance: 0 };

  for (const paiement of paiementsAtraiter) {
    const texte = paiement.description || "";
    const candidats = factures.filter(
      (f) => referencePresente(texte, f.reference) || (f.bonCommande && referencePresente(texte, f.bonCommande))
    );

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
