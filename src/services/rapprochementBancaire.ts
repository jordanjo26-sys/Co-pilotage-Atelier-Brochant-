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
// Le terminal carte (Tap to Pay) encaisse les paiements d'une journee et la
// banque les credite en un seul lot ("REMISE CB") le ou les jours suivants
// (demande explicite de l'utilisateur : "quand elle date du 9-10, c'est
// qu'il y a eu des reglements le 8-10 en carte bleue"). Fenetre volontairement
// un peu plus large qu'un seul jour pour absorber un week-end/jour ferie -
// la securite vient de l'egalite exacte de la somme, jamais de la largeur
// de la fenetre.
const FENETRE_JOURS_REMISE_CB = 4;
const TOLERANCE_MONTANT = 0.01; // arrondi centime

export interface ResultatRapprochement {
  nbRapproches: number;
  nbAmbigus: number;
  nbSansCorrespondance: number;
  nbRapprochesFournisseurs: number;
  nbAmbigusFournisseurs: number;
  nbSansCorrespondanceFournisseurs: number;
  // Rapprochement des vraies factures fournisseurs (DocumentFournisseur,
  // celles qui arrivent par Gmail/Dext) - voir plus bas pourquoi c'est une
  // deuxieme passe distincte de nbRapprochesFournisseurs ci-dessus.
  nbRapprochesDocuments: number;
  nbAmbigusDocuments: number;
  nbSansCorrespondanceDocuments: number;
  // Rapprochement des remises carte bleue (MouvementBancaire "REMISE CB")
  // avec les encaissements clients en carte (Encaissement.mode = "Carte") -
  // voir plus bas, troisieme source de credits possibles cote clients.
  nbRapprochesRemisesCb: number;
  nbAmbigusRemisesCb: number;
  nbSansCorrespondanceRemisesCb: number;
  details: Array<{ payoutRef: string; resultat: "rapproche" | "ambigu" | "sans_correspondance"; mouvementId?: string }>;
  detailsFournisseurs: Array<{
    factureId: string;
    reference: string | null;
    resultat: "rapproche" | "ambigu" | "sans_correspondance";
    mouvementId?: string;
  }>;
  detailsDocuments: Array<{
    documentId: string;
    fichierNom: string | null;
    resultat: "rapproche" | "ambigu" | "sans_correspondance";
    mouvementId?: string;
  }>;
  detailsRemisesCb: Array<{
    mouvementId: string;
    resultat: "rapproche" | "ambigu" | "sans_correspondance";
    nbEncaissements?: number;
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
    nbRapprochesDocuments: 0,
    nbAmbigusDocuments: 0,
    nbSansCorrespondanceDocuments: 0,
    nbRapprochesRemisesCb: 0,
    nbAmbigusRemisesCb: 0,
    nbSansCorrespondanceRemisesCb: 0,
    details: [],
    detailsFournisseurs: [],
    detailsDocuments: [],
    detailsRemisesCb: [],
  };
  // Un mouvement deja affecte au cours de cette meme execution (payout,
  // facture fournisseur ou document fournisseur) ne doit pas etre propose
  // une seconde fois.
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

  // --- Documents fournisseurs (debit) ---------------------------------
  // FactureFournisseur (passe ci-dessus) n'est alimentee par aucun code
  // actif de l'application - en pratique toujours vide. Les vraies
  // factures fournisseurs (celles qui arrivent par Gmail/Dext, visibles
  // dans Comptabilite/Depenses par fournisseur) vivent dans
  // DocumentFournisseur : c'est cette table qu'il faut rapprocher pour que
  // le pointage bancaire des depenses soit utile en pratique (demande
  // explicite de l'utilisateur). Meme logique que la passe precedente -
  // seule la source change.
  const [documentsAtraiter, mouvementsDebitDocuments] = await Promise.all([
    prisma.documentFournisseur.findMany({
      where: { type: "facture", montantTTC: { not: null }, mouvementBancaireId: null },
    }),
    prisma.mouvementBancaire.findMany({ where: { rapprochementStatut: "non_rapproche", debit: { gt: 0 } } }),
  ]);

  for (const document of documentsAtraiter) {
    const dateReference = document.date ?? document.dateReceptionMail;
    if (dateReference === null) {
      // Pas de date de reference exploitable : jamais de rapprochement a
      // l'aveugle sur le montant seul (section 14).
      resultat.nbSansCorrespondanceDocuments++;
      resultat.detailsDocuments.push({ documentId: document.id, fichierNom: document.fichierNom, resultat: "sans_correspondance" });
      continue;
    }
    const candidats = mouvementsDebitDocuments.filter(
      (m) =>
        !dejaUtilises.has(m.id) &&
        Math.abs(m.debit - (document.montantTTC as number)) < TOLERANCE_MONTANT &&
        differenceJours(m.date, dateReference) <= FENETRE_JOURS_FACTURE_FOURNISSEUR
    );

    if (candidats.length === 1) {
      const mouvement = candidats[0];
      await prisma.$transaction([
        prisma.documentFournisseur.update({ where: { id: document.id }, data: { mouvementBancaireId: mouvement.id } }),
        prisma.mouvementBancaire.update({ where: { id: mouvement.id }, data: { rapprochementStatut: "rapproche" } }),
      ]);
      dejaUtilises.add(mouvement.id);
      resultat.nbRapprochesDocuments++;
      resultat.detailsDocuments.push({ documentId: document.id, fichierNom: document.fichierNom, resultat: "rapproche", mouvementId: mouvement.id });
    } else if (candidats.length > 1) {
      resultat.nbAmbigusDocuments++;
      resultat.detailsDocuments.push({ documentId: document.id, fichierNom: document.fichierNom, resultat: "ambigu" });
    } else {
      resultat.nbSansCorrespondanceDocuments++;
      resultat.detailsDocuments.push({ documentId: document.id, fichierNom: document.fichierNom, resultat: "sans_correspondance" });
    }
  }

  // --- Remises carte bleue (credit) <-> encaissements clients ----------
  // Une "REMISE CB" regroupe en un seul credit tous les paiements carte
  // (Tap to Pay) encaisses sur une journee donnee - jamais un sous-ensemble
  // arbitraire choisi pour faire correspondre un montant (ce serait deviner),
  // seulement "tous les encaissements Carte d'un jour calendaire precis",
  // qui est la realite physique d'un releve de terminal. Le montant de
  // reference est le BRUT (avant commission bancaire) : c'est ce que les
  // clients ont paye, jamais le montant net credite sur le compte.
  const remisesAtraiter = await prisma.mouvementBancaire.findMany({
    where: { rapprochementStatut: "non_rapproche", montantBrut: { not: null } },
  });

  if (remisesAtraiter.length > 0) {
    const encaissementsCarte = await prisma.encaissement.findMany({
      where: { mode: "Carte", mouvementBancaireId: null, date: { not: null } },
    });
    const encaissementsUtilises = new Set<string>();

    for (const remise of remisesAtraiter) {
      const parJour = new Map<string, typeof encaissementsCarte>();
      for (const e of encaissementsCarte) {
        if (encaissementsUtilises.has(e.id) || !e.date) continue;
        if (e.date > remise.date) continue; // un encaissement ne peut jamais precede sa propre remise
        if (differenceJours(e.date, remise.date) > FENETRE_JOURS_REMISE_CB) continue;
        const cle = e.date.toISOString().slice(0, 10);
        const liste = parJour.get(cle) ?? [];
        liste.push(e);
        parJour.set(cle, liste);
      }

      const joursCandidats: Array<{ encaissements: typeof encaissementsCarte }> = [];
      for (const encaissementsJour of parJour.values()) {
        const somme = encaissementsJour.reduce((s, e) => s + e.montant, 0);
        if (Math.abs(somme - (remise.montantBrut as number)) < TOLERANCE_MONTANT) {
          joursCandidats.push({ encaissements: encaissementsJour });
        }
      }

      if (joursCandidats.length === 1) {
        const { encaissements } = joursCandidats[0];
        await prisma.$transaction([
          ...encaissements.map((e) =>
            prisma.encaissement.update({ where: { id: e.id }, data: { mouvementBancaireId: remise.id } })
          ),
          prisma.mouvementBancaire.update({ where: { id: remise.id }, data: { rapprochementStatut: "rapproche" } }),
        ]);
        for (const e of encaissements) encaissementsUtilises.add(e.id);
        resultat.nbRapprochesRemisesCb++;
        resultat.detailsRemisesCb.push({ mouvementId: remise.id, resultat: "rapproche", nbEncaissements: encaissements.length });
      } else if (joursCandidats.length > 1) {
        resultat.nbAmbigusRemisesCb++;
        resultat.detailsRemisesCb.push({ mouvementId: remise.id, resultat: "ambigu" });
      } else {
        resultat.nbSansCorrespondanceRemisesCb++;
        resultat.detailsRemisesCb.push({ mouvementId: remise.id, resultat: "sans_correspondance" });
      }
    }
  }

  if (
    resultat.nbRapproches > 0 ||
    resultat.nbAmbigus > 0 ||
    resultat.nbRapprochesFournisseurs > 0 ||
    resultat.nbAmbigusFournisseurs > 0 ||
    resultat.nbRapprochesDocuments > 0 ||
    resultat.nbAmbigusDocuments > 0 ||
    resultat.nbRapprochesRemisesCb > 0 ||
    resultat.nbAmbigusRemisesCb > 0
  ) {
    await logEvenement(prisma, {
      evenement: "rapprochement_bancaire",
      action: "Rapprochement automatique payouts/factures fournisseurs <-> mouvements bancaires",
      resultat: `Payouts : ${resultat.nbRapproches} rapproche(s), ${resultat.nbAmbigus} ambigu(s), ${resultat.nbSansCorrespondance} sans correspondance. Factures fournisseurs : ${resultat.nbRapprochesFournisseurs} rapprochee(s), ${resultat.nbAmbigusFournisseurs} ambigue(s), ${resultat.nbSansCorrespondanceFournisseurs} sans correspondance. Documents fournisseurs : ${resultat.nbRapprochesDocuments} rapproche(s), ${resultat.nbAmbigusDocuments} ambigu(s), ${resultat.nbSansCorrespondanceDocuments} sans correspondance. Remises carte bleue : ${resultat.nbRapprochesRemisesCb} rapprochee(s), ${resultat.nbAmbigusRemisesCb} ambigue(s), ${resultat.nbSansCorrespondanceRemisesCb} sans correspondance.`,
    });
  }

  return resultat;
}
