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
// Le terminal carte (Tap to Pay) encaisse les paiements et la banque les
// credite en lot ("REMISE CB") le ou les jours suivants. Verifie sur les
// donnees reelles de production (jamais suppose - section 14) via
// /api/encaissements : un lot n'est PAS toujours "toute une journee
// calendaire" (un terminal peut scinder une journee en plusieurs lots), et
// un encaissement peut meme etre saisi dans Synec un jour APRES la date de
// la remise bancaire (decalage de saisie, cas reel observe le 2026-10-08/09).
// D'ou une fenetre asymetrique et une recherche par SOUS-ENSEMBLE EXACT
// (voir rechercherSousEnsemblesExacts) plutot qu'un simple regroupement par
// jour - la securite vient de l'unicite du sous-ensemble exact, jamais de
// la largeur de la fenetre.
const FENETRE_JOURS_REMISE_CB_AVANT = 4;
const FENETRE_JOURS_REMISE_CB_APRES = 1;
// Une remise de cheques peut regrouper des cheques encaisses sur une
// periode bien plus longue et irreguliere qu'une remise CB (le depot en
// banque n'est pas quotidien) - verifie sur les 12 remises reelles de
// production : l'ecart constate entre la date d'un encaissement cheque et
// la remise bancaire correspondante va jusqu'a plusieurs mois. Meme
// principe de securite : sous-ensemble exact et unique, jamais une
// supposition sur le regroupement.
const FENETRE_JOURS_REMISE_CHEQUES_AVANT = 90;
const FENETRE_JOURS_REMISE_CHEQUES_APRES = 5;
// Au-dela de ce nombre de candidats dans la fenetre, une recherche
// exhaustive de sous-ensemble exact n'est plus pratiquee (jamais de
// raccourci qui risquerait un mauvais rapprochement) - le mouvement reste
// simplement "sans_correspondance" comme avant cette passe. Jamais atteint
// en pratique sur les donnees reelles (maximum observe : 20 candidats).
const LIMITE_CANDIDATS_SOUS_ENSEMBLE = 25;
// Un virement client (VIR INST, EVI...) n'est jamais regroupe en lot
// (contrairement a une remise CB ou cheques) - chaque ligne du releve
// correspond a un seul encaissement. Le nom affiche sur le releve ne
// correspond pas toujours au nom du client dans Synec (demande explicite
// de l'utilisateur : "Ethan Zerbib" sur le compte peut correspondre a une
// autre raison sociale cote facture) - jamais de recherche par nom, donc,
// uniquement montant + fenetre de dates, comme les autres rapprochements
// de ce fichier.
const FENETRE_JOURS_VIREMENT_CLIENT = 5;
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
  // Rapprochement des remises de cheques (MouvementBancaire "REMISE
  // CHEQUES"/"REM CHQ") avec les encaissements clients en cheque
  // (Encaissement.mode = "Chèque") - meme principe que les remises CB,
  // fenetre de dates differente (voir FENETRE_JOURS_REMISE_CHEQUES_*).
  nbRapprochesRemisesCheques: number;
  nbAmbigusRemisesCheques: number;
  nbSansCorrespondanceRemisesCheques: number;
  // Rapprochement des virements clients directs (hors remise CB/Stripe,
  // un seul encaissement par mouvement, jamais un lot) - voir plus bas.
  nbRapprochesVirementsClients: number;
  nbAmbigusVirementsClients: number;
  nbSansCorrespondanceVirementsClients: number;
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
  detailsRemisesCheques: Array<{
    mouvementId: string;
    resultat: "rapproche" | "ambigu" | "sans_correspondance";
    nbEncaissements?: number;
  }>;
  detailsVirementsClients: Array<{
    mouvementId: string;
    libelle: string;
    resultat: "rapproche" | "ambigu" | "sans_correspondance";
    encaissementId?: string;
  }>;
}

function differenceJours(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Recherche tous les sous-ensembles de `candidats` dont la somme egale
 * exactement `cibleCentimes` (en centimes, pour eviter les arrondis
 * flottants), avec arret anticipe dans deux cas :
 *  - plus de deux sous-ensembles trouves (l'ambiguite est deja etablie,
 *    pas besoin d'enumerer tous les cas) ;
 *  - trop de candidats pour une recherche exhaustive fiable (voir
 *    LIMITE_CANDIDATS_SOUS_ENSEMBLE) - renvoie alors null plutot que de
 *    deviner sur un sous-ensemble partiel.
 * Un elagage par somme suffixe (candidats tries par montant decroissant)
 * rend la recherche quasi instantanee dans les cas reels, ou tres peu de
 * sous-ensembles atteignent exactement la cible.
 */
function rechercherSousEnsemblesExacts<T>(
  candidats: Array<{ item: T; montant: number }>,
  cibleCentimes: number
): Array<T[]> | null {
  if (candidats.length === 0 || cibleCentimes <= 0) return [];
  if (candidats.length > LIMITE_CANDIDATS_SOUS_ENSEMBLE) return null;

  const tries = [...candidats].sort((a, b) => b.montant - a.montant);
  const sommesSuffixe = new Array<number>(tries.length + 1).fill(0);
  for (let i = tries.length - 1; i >= 0; i--) {
    sommesSuffixe[i] = sommesSuffixe[i + 1] + Math.round(tries[i].montant * 100);
  }

  const resultats: T[][] = [];

  function backtrack(depart: number, resteCentimes: number, chemin: T[]) {
    if (resultats.length >= 2) return;
    if (resteCentimes === 0 && chemin.length > 0) {
      resultats.push([...chemin]);
      if (resultats.length >= 2) return;
    }
    for (let i = depart; i < tries.length; i++) {
      if (sommesSuffixe[i] < resteCentimes) break; // meme les plus gros restants n'atteignent pas la cible
      const centimes = Math.round(tries[i].montant * 100);
      if (centimes > resteCentimes) continue; // cet element seul depasse deja le reste
      chemin.push(tries[i].item);
      backtrack(i + 1, resteCentimes - centimes, chemin);
      chemin.pop();
      if (resultats.length >= 2) return;
    }
  }
  backtrack(0, cibleCentimes, []);
  return resultats;
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
    nbRapprochesRemisesCheques: 0,
    nbAmbigusRemisesCheques: 0,
    nbSansCorrespondanceRemisesCheques: 0,
    nbRapprochesVirementsClients: 0,
    nbAmbigusVirementsClients: 0,
    nbSansCorrespondanceVirementsClients: 0,
    details: [],
    detailsFournisseurs: [],
    detailsDocuments: [],
    detailsRemisesCb: [],
    detailsRemisesCheques: [],
    detailsVirementsClients: [],
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

  // --- Remises en lot (carte bleue / cheques) <-> encaissements clients ---
  // Une remise bancaire ("REMISE CB" ou "REMISE CHEQUES"/"REM CHQ") regroupe
  // en un seul credit plusieurs encaissements clients du mode correspondant.
  // Jamais de sous-ensemble arbitraire choisi pour faire correspondre un
  // montant (ce serait deviner, section 14) : rechercherSousEnsemblesExacts
  // trouve le ou les sous-ensembles dont la somme egale EXACTEMENT la cible,
  // et seule une correspondance unique declenche le rapprochement. Pour une
  // remise CB, la cible est le montant BRUT (avant commission bancaire) :
  // c'est ce que les clients ont paye, jamais le montant net credite sur le
  // compte ; une remise de cheques n'a pas de commission, la cible est donc
  // le montant du mouvement lui-meme.
  async function rapprocherRemiseEnLot(
    remise: { id: string; date: Date },
    cible: number,
    mode: string,
    encaissementsDisponibles: Array<{ id: string; date: Date | null; montant: number }>,
    fenetreAvantJours: number,
    fenetreApresJours: number
  ): Promise<{ resultat: "rapproche" | "ambigu" | "sans_correspondance"; encaissements?: Array<{ id: string }> }> {
    const candidats = encaissementsDisponibles.filter((e) => {
      if (!e.date) return false;
      const diffJours = (e.date.getTime() - remise.date.getTime()) / (1000 * 60 * 60 * 24);
      return diffJours <= fenetreApresJours && diffJours >= -fenetreAvantJours;
    });

    const sousEnsembles = rechercherSousEnsemblesExacts(
      candidats.map((e) => ({ item: e, montant: e.montant })),
      Math.round(cible * 100)
    );

    if (sousEnsembles === null || sousEnsembles.length === 0) {
      return { resultat: "sans_correspondance" };
    }
    if (sousEnsembles.length > 1) {
      return { resultat: "ambigu" };
    }
    void mode; // deja filtre par l'appelant via encaissementsDisponibles
    return { resultat: "rapproche", encaissements: sousEnsembles[0] };
  }

  const remisesCbAtraiter = await prisma.mouvementBancaire.findMany({
    where: { rapprochementStatut: "non_rapproche", montantBrut: { not: null } },
  });

  if (remisesCbAtraiter.length > 0) {
    const encaissementsCarte = await prisma.encaissement.findMany({
      where: { mode: "Carte", mouvementBancaireId: null, date: { not: null } },
    });
    const encaissementsUtilises = new Set<string>();

    for (const remise of remisesCbAtraiter) {
      const disponibles = encaissementsCarte.filter((e) => !encaissementsUtilises.has(e.id));
      const { resultat: issue, encaissements } = await rapprocherRemiseEnLot(
        remise,
        remise.montantBrut as number,
        "Carte",
        disponibles,
        FENETRE_JOURS_REMISE_CB_AVANT,
        FENETRE_JOURS_REMISE_CB_APRES
      );

      if (issue === "rapproche" && encaissements) {
        await prisma.$transaction([
          ...encaissements.map((e) =>
            prisma.encaissement.update({ where: { id: e.id }, data: { mouvementBancaireId: remise.id } })
          ),
          prisma.mouvementBancaire.update({ where: { id: remise.id }, data: { rapprochementStatut: "rapproche" } }),
        ]);
        for (const e of encaissements) encaissementsUtilises.add(e.id);
        resultat.nbRapprochesRemisesCb++;
        resultat.detailsRemisesCb.push({ mouvementId: remise.id, resultat: "rapproche", nbEncaissements: encaissements.length });
      } else if (issue === "ambigu") {
        resultat.nbAmbigusRemisesCb++;
        resultat.detailsRemisesCb.push({ mouvementId: remise.id, resultat: "ambigu" });
      } else {
        resultat.nbSansCorrespondanceRemisesCb++;
        resultat.detailsRemisesCb.push({ mouvementId: remise.id, resultat: "sans_correspondance" });
      }
    }
  }

  // --- Remises de cheques (credit) <-> encaissements clients Cheque ----
  // Meme principe que les remises CB ci-dessus, fenetre de dates
  // beaucoup plus large (voir FENETRE_JOURS_REMISE_CHEQUES_*) : un depot
  // de cheques en banque n'est pas quotidien, et peut regrouper des
  // cheques encaisses sur plusieurs mois.
  const LIBELLE_REMISE_CHEQUES = /^REMISE CHEQUES|^REM CHQ/i;
  const mouvementsNonRapproches = await prisma.mouvementBancaire.findMany({
    where: { rapprochementStatut: "non_rapproche" },
  });
  const remisesChequesAtraiter = mouvementsNonRapproches.filter((m) => LIBELLE_REMISE_CHEQUES.test(m.libelle));

  if (remisesChequesAtraiter.length > 0) {
    const encaissementsCheque = await prisma.encaissement.findMany({
      where: { mode: "Chèque", mouvementBancaireId: null, date: { not: null } },
    });
    const encaissementsUtilisesCheque = new Set<string>();

    for (const remise of remisesChequesAtraiter) {
      const disponibles = encaissementsCheque.filter((e) => !encaissementsUtilisesCheque.has(e.id));
      const { resultat: issue, encaissements } = await rapprocherRemiseEnLot(
        remise,
        remise.montant,
        "Chèque",
        disponibles,
        FENETRE_JOURS_REMISE_CHEQUES_AVANT,
        FENETRE_JOURS_REMISE_CHEQUES_APRES
      );

      if (issue === "rapproche" && encaissements) {
        await prisma.$transaction([
          ...encaissements.map((e) =>
            prisma.encaissement.update({ where: { id: e.id }, data: { mouvementBancaireId: remise.id } })
          ),
          prisma.mouvementBancaire.update({ where: { id: remise.id }, data: { rapprochementStatut: "rapproche" } }),
        ]);
        for (const e of encaissements) encaissementsUtilisesCheque.add(e.id);
        resultat.nbRapprochesRemisesCheques++;
        resultat.detailsRemisesCheques.push({ mouvementId: remise.id, resultat: "rapproche", nbEncaissements: encaissements.length });
      } else if (issue === "ambigu") {
        resultat.nbAmbigusRemisesCheques++;
        resultat.detailsRemisesCheques.push({ mouvementId: remise.id, resultat: "ambigu" });
      } else {
        resultat.nbSansCorrespondanceRemisesCheques++;
        resultat.detailsRemisesCheques.push({ mouvementId: remise.id, resultat: "sans_correspondance" });
      }
    }
  }

  // --- Virements clients directs (credit, hors remise/Stripe) ----------
  // Un virement/EVI recu directement (pas via Stripe, pas regroupe en
  // remise CB) correspond toujours a un seul encaissement - jamais un lot.
  // Exclut explicitement les remises (REMISE CB/REMISE CHEQUES/REM CHQ -
  // des lots, pas des paiements individuels, non geres ici) et tout libelle
  // Stripe (deja couvert par sa propre passe ci-dessus, montant net precis).
  const LIBELLE_EXCLU_VIREMENT_CLIENT = /^REMISE CB|^REMISE CHEQUES|^REM CHQ|STRIPE/i;
  const creditsRestants = mouvementsCredit.filter(
    (m) => !dejaUtilises.has(m.id) && m.montant > 0 && !LIBELLE_EXCLU_VIREMENT_CLIENT.test(m.libelle)
  );

  if (creditsRestants.length > 0) {
    const encaissementsVirement = await prisma.encaissement.findMany({
      where: { mode: "Virement", mouvementBancaireId: null, date: { not: null } },
    });
    const encaissementsUtilisesVirement = new Set<string>();

    for (const mouvement of creditsRestants) {
      const candidats = encaissementsVirement.filter(
        (e) =>
          !encaissementsUtilisesVirement.has(e.id) &&
          Math.abs(e.montant - mouvement.montant) < TOLERANCE_MONTANT &&
          differenceJours(e.date as Date, mouvement.date) <= FENETRE_JOURS_VIREMENT_CLIENT
      );

      if (candidats.length === 1) {
        const encaissement = candidats[0];
        await prisma.$transaction([
          prisma.encaissement.update({ where: { id: encaissement.id }, data: { mouvementBancaireId: mouvement.id } }),
          prisma.mouvementBancaire.update({ where: { id: mouvement.id }, data: { rapprochementStatut: "rapproche" } }),
        ]);
        encaissementsUtilisesVirement.add(encaissement.id);
        resultat.nbRapprochesVirementsClients++;
        resultat.detailsVirementsClients.push({
          mouvementId: mouvement.id,
          libelle: mouvement.libelle,
          resultat: "rapproche",
          encaissementId: encaissement.id,
        });
      } else if (candidats.length > 1) {
        resultat.nbAmbigusVirementsClients++;
        resultat.detailsVirementsClients.push({ mouvementId: mouvement.id, libelle: mouvement.libelle, resultat: "ambigu" });
      } else {
        resultat.nbSansCorrespondanceVirementsClients++;
        resultat.detailsVirementsClients.push({ mouvementId: mouvement.id, libelle: mouvement.libelle, resultat: "sans_correspondance" });
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
    resultat.nbAmbigusRemisesCb > 0 ||
    resultat.nbRapprochesRemisesCheques > 0 ||
    resultat.nbAmbigusRemisesCheques > 0 ||
    resultat.nbRapprochesVirementsClients > 0 ||
    resultat.nbAmbigusVirementsClients > 0
  ) {
    await logEvenement(prisma, {
      evenement: "rapprochement_bancaire",
      action: "Rapprochement automatique payouts/factures fournisseurs <-> mouvements bancaires",
      resultat: `Payouts : ${resultat.nbRapproches} rapproche(s), ${resultat.nbAmbigus} ambigu(s), ${resultat.nbSansCorrespondance} sans correspondance. Factures fournisseurs : ${resultat.nbRapprochesFournisseurs} rapprochee(s), ${resultat.nbAmbigusFournisseurs} ambigue(s), ${resultat.nbSansCorrespondanceFournisseurs} sans correspondance. Documents fournisseurs : ${resultat.nbRapprochesDocuments} rapproche(s), ${resultat.nbAmbigusDocuments} ambigu(s), ${resultat.nbSansCorrespondanceDocuments} sans correspondance. Remises carte bleue : ${resultat.nbRapprochesRemisesCb} rapprochee(s), ${resultat.nbAmbigusRemisesCb} ambigue(s), ${resultat.nbSansCorrespondanceRemisesCb} sans correspondance. Remises cheques : ${resultat.nbRapprochesRemisesCheques} rapprochee(s), ${resultat.nbAmbigusRemisesCheques} ambigue(s), ${resultat.nbSansCorrespondanceRemisesCheques} sans correspondance. Virements clients directs : ${resultat.nbRapprochesVirementsClients} rapproche(s), ${resultat.nbAmbigusVirementsClients} ambigu(s), ${resultat.nbSansCorrespondanceVirementsClients} sans correspondance.`,
    });
  }

  return resultat;
}
