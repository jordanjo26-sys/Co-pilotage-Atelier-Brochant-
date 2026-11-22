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
// Certains fournisseurs recurrents (EDF, Bouygues Telecom...) ne passent
// jamais par Gmail/Dext : leurs factures sont telechargees directement en
// PDF et vivent uniquement dans le module Comptabilite (ArchiveComptable),
// jamais dans DocumentFournisseur (demande explicite de l'utilisateur,
// verifie via /api/archives-comptables?fournisseurNom=... - 10 factures
// Bouygues Telecom et 29 factures EDF trouvees ainsi, 0 cote
// DocumentFournisseur). Meme fenetre et meme principe de securite que les
// factures fournisseurs Dext ci-dessus.
const FENETRE_JOURS_ARCHIVE_COMPTABLE = 20;
// Un virement client (VIR INST, EVI...) n'est jamais regroupe en lot
// (contrairement a une remise CB ou cheques) - chaque ligne du releve
// correspond a un seul encaissement. Le nom affiche sur le releve ne
// correspond pas toujours au nom du client dans Synec (demande explicite
// de l'utilisateur : "Ethan Zerbib" sur le compte peut correspondre a une
// autre raison sociale cote facture) - jamais de recherche par nom, donc,
// uniquement montant + fenetre de dates, comme les autres rapprochements
// de ce fichier.
const FENETRE_JOURS_VIREMENT_CLIENT = 5;
// Exporte (plutot que prive au module) : reutilise par validerRapprochementManuel
// ci-dessous pour verifier qu'un reglement manuel ne depasse jamais le
// montant reel du mouvement, avec la meme tolerance d'arrondi.
export const TOLERANCE_MONTANT = 0.01; // arrondi centime

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
  // Rapprochement des factures archivees hors circuit Dext (module
  // Comptabilite, ArchiveComptable) - ex. EDF, Bouygues Telecom, qui ne
  // passent jamais par Gmail. Voir plus bas.
  nbRapprochesArchives: number;
  nbAmbigusArchives: number;
  nbSansCorrespondanceArchives: number;
  // Reglements partiels/multi-factures (debit) : un mouvement qui regle
  // plusieurs factures (ArchiveComptable et/ou DocumentFournisseur) a la
  // fois, via un ensemble unique en somme exacte - voir
  // rechercherSousEnsemblesExacts plus haut (meme principe que les remises
  // CB/cheques cote credit). Jamais de montant partiel devine : un
  // reglement reellement partiel (aucun sous-ensemble exact) n'est jamais
  // compte ici, il reste disponible pour validerRapprochementManuel.
  nbRapprochesMultiFactures: number;
  nbAmbigusMultiFactures: number;
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
  detailsArchives: Array<{
    archiveId: string;
    fichierNom: string;
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
 * Historique de chaque rapprochement et de ses modifications (demande
 * explicite de l'utilisateur) - une ligne d'audit par action, jamais
 * ecrasee ni supprimee (voir RapprochementHistorique dans schema.prisma).
 */
async function logRapprochementHistorique(
  prisma: PrismaClient,
  params: { mouvementBancaireId: string; action: string; ancienStatut: string | null; nouveauStatut: string; detail?: string; auteur?: string }
) {
  await prisma.rapprochementHistorique.create({
    data: {
      mouvementBancaireId: params.mouvementBancaireId,
      action: params.action,
      ancienStatut: params.ancienStatut,
      nouveauStatut: params.nouveauStatut,
      detail: params.detail ?? null,
      auteur: params.auteur ?? null,
    },
  });
}

/**
 * Persiste l'ambiguite d'un ou plusieurs mouvements candidats (jusqu'ici
 * silencieusement perdue : seul un compteur en memoire existait, voir
 * ResultatRapprochement.nbAmbigus*) - ferme le trou central identifie dans
 * le plan de restructuration : sans cette ecriture, aucune interface ne
 * peut jamais afficher "a confirmer" (orange), le statut n'existant qu'en
 * commentaire de schema jusqu'ici, jamais reellement ecrit.
 */
async function marquerMouvementsAmbigus(prisma: PrismaClient, mouvementIds: string[], detail?: string) {
  for (const id of mouvementIds) {
    await prisma.mouvementBancaire.update({ where: { id }, data: { rapprochementStatut: "a_verifier" } });
    await logRapprochementHistorique(prisma, {
      mouvementBancaireId: id,
      action: "ambigu",
      ancienStatut: "non_rapproche",
      nouveauStatut: "a_verifier",
      detail,
    });
  }
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
    nbRapprochesArchives: 0,
    nbAmbigusArchives: 0,
    nbSansCorrespondanceArchives: 0,
    nbRapprochesMultiFactures: 0,
    nbAmbigusMultiFactures: 0,
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
    detailsArchives: [],
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
      await marquerMouvementsAmbigus(prisma, candidats.map((m) => m.id), `Payout ${payout.payoutRef} : ${candidats.length} mouvements candidats au meme montant.`);
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
      await marquerMouvementsAmbigus(prisma, candidats.map((m) => m.id), `Facture fournisseur ${facture.reference ?? facture.id} : ${candidats.length} mouvements candidats au meme montant.`);
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
      await marquerMouvementsAmbigus(prisma, candidats.map((m) => m.id), `Document fournisseur ${document.fichierNom ?? document.id} : ${candidats.length} mouvements candidats au meme montant.`);
      resultat.nbAmbigusDocuments++;
      resultat.detailsDocuments.push({ documentId: document.id, fichierNom: document.fichierNom, resultat: "ambigu" });
    } else {
      resultat.nbSansCorrespondanceDocuments++;
      resultat.detailsDocuments.push({ documentId: document.id, fichierNom: document.fichierNom, resultat: "sans_correspondance" });
    }
  }

  // --- Archives comptables hors Dext (debit) --------------------------
  // Demande explicite de l'utilisateur : certains fournisseurs recurrents
  // (EDF, Bouygues Telecom...) ne sont jamais recus par Gmail - la facture
  // est telechargee directement en PDF et deposee dans le module
  // Comptabilite (ArchiveComptable), jamais dans DocumentFournisseur.
  // Meme logique que la passe precedente, seule la source change.
  const [archivesAtraiter, mouvementsDebitArchives] = await Promise.all([
    prisma.archiveComptable.findMany({
      where: { montantTTC: { not: null }, mouvementBancaireId: null },
    }),
    prisma.mouvementBancaire.findMany({ where: { rapprochementStatut: "non_rapproche", debit: { gt: 0 } } }),
  ]);

  for (const archive of archivesAtraiter) {
    if (archive.dateFacture === null) {
      // Pas de date de reference exploitable : jamais de rapprochement a
      // l'aveugle sur le montant seul (section 14).
      resultat.nbSansCorrespondanceArchives++;
      resultat.detailsArchives.push({ archiveId: archive.id, fichierNom: archive.fichierNom, resultat: "sans_correspondance" });
      continue;
    }
    const candidats = mouvementsDebitArchives.filter(
      (m) =>
        !dejaUtilises.has(m.id) &&
        Math.abs(m.debit - (archive.montantTTC as number)) < TOLERANCE_MONTANT &&
        differenceJours(m.date, archive.dateFacture as Date) <= FENETRE_JOURS_ARCHIVE_COMPTABLE
    );

    if (candidats.length === 1) {
      const mouvement = candidats[0];
      await prisma.$transaction([
        prisma.archiveComptable.update({ where: { id: archive.id }, data: { mouvementBancaireId: mouvement.id } }),
        prisma.mouvementBancaire.update({ where: { id: mouvement.id }, data: { rapprochementStatut: "rapproche" } }),
      ]);
      dejaUtilises.add(mouvement.id);
      resultat.nbRapprochesArchives++;
      resultat.detailsArchives.push({ archiveId: archive.id, fichierNom: archive.fichierNom, resultat: "rapproche", mouvementId: mouvement.id });
    } else if (candidats.length > 1) {
      await marquerMouvementsAmbigus(prisma, candidats.map((m) => m.id), `Archive comptable ${archive.fichierNom} : ${candidats.length} mouvements candidats au meme montant.`);
      resultat.nbAmbigusArchives++;
      resultat.detailsArchives.push({ archiveId: archive.id, fichierNom: archive.fichierNom, resultat: "ambigu" });
    } else {
      resultat.nbSansCorrespondanceArchives++;
      resultat.detailsArchives.push({ archiveId: archive.id, fichierNom: archive.fichierNom, resultat: "sans_correspondance" });
    }
  }

  // --- Reglements partiels / multi-factures (debit) --------------------
  // Demande explicite de l'utilisateur : un reglement bancaire peut couvrir
  // plusieurs factures a la fois, ou regler une facture pour un montant qui
  // ne correspond a aucune facture seule. Decision fixee (jamais de pari
  // sur un montant inexact, section 14) : seul un ENSEMBLE UNIQUE de
  // factures (ArchiveComptable et/ou DocumentFournisseur, pas encore
  // rapprochees) dont la somme egale EXACTEMENT le mouvement est rapproche
  // ici - reutilise rechercherSousEnsemblesExacts, deja utilise cote credit
  // pour les remises CB/cheques. Un reglement reellement partiel (aucun
  // sous-ensemble exact) n'est jamais devine : il reste disponible pour un
  // rattachement manuel (voir validerRapprochementManuel plus bas).
  const mouvementsDebitRestants = (
    await prisma.mouvementBancaire.findMany({ where: { rapprochementStatut: "non_rapproche", debit: { gt: 0 } } })
  ).filter((m) => !dejaUtilises.has(m.id));

  if (mouvementsDebitRestants.length > 0) {
    const [archivesDisponibles, documentsDisponibles] = await Promise.all([
      prisma.archiveComptable.findMany({ where: { montantTTC: { not: null }, dateFacture: { not: null }, mouvementBancaireId: null } }),
      prisma.documentFournisseur.findMany({ where: { type: "facture", montantTTC: { not: null }, mouvementBancaireId: null } }),
    ]);
    type CibleMulti = { cibleType: "archive_comptable" | "document_fournisseur"; cibleId: string; montant: number; date: Date };
    const facturesDisponibles: CibleMulti[] = [
      ...archivesDisponibles.map((a) => ({ cibleType: "archive_comptable" as const, cibleId: a.id, montant: a.montantTTC as number, date: a.dateFacture as Date })),
      ...documentsDisponibles
        .filter((d) => d.date !== null || d.dateReceptionMail !== null)
        .map((d) => ({ cibleType: "document_fournisseur" as const, cibleId: d.id, montant: d.montantTTC as number, date: (d.date ?? d.dateReceptionMail) as Date })),
    ];
    const facturesUtiliseesMulti = new Set<string>();

    for (const mouvement of mouvementsDebitRestants) {
      const candidats = facturesDisponibles.filter(
        (f) => !facturesUtiliseesMulti.has(f.cibleId) && differenceJours(f.date, mouvement.date) <= FENETRE_JOURS_FACTURE_FOURNISSEUR
      );
      // Un seul candidat exact aurait deja ete rapproche par l'une des
      // passes precedentes (chacune cherche deja une correspondance 1-a-1) -
      // cette passe n'a d'interet qu'a partir de 2 candidats.
      if (candidats.length < 2) continue;

      const sousEnsembles = rechercherSousEnsemblesExacts(
        candidats.map((f) => ({ item: f, montant: f.montant })),
        Math.round(mouvement.debit * 100)
      );
      if (sousEnsembles === null || sousEnsembles.length === 0) continue;

      if (sousEnsembles.length > 1) {
        await marquerMouvementsAmbigus(
          prisma,
          [mouvement.id],
          `Reglement multi-factures : plusieurs combinaisons de factures correspondent exactement au montant ${mouvement.debit}.`
        );
        resultat.nbAmbigusMultiFactures++;
        continue;
      }

      const ensemble = sousEnsembles[0];
      await prisma.$transaction([
        ...ensemble.map((f) =>
          f.cibleType === "archive_comptable"
            ? prisma.archiveComptable.update({ where: { id: f.cibleId }, data: { mouvementBancaireId: mouvement.id } })
            : prisma.documentFournisseur.update({ where: { id: f.cibleId }, data: { mouvementBancaireId: mouvement.id } })
        ),
        ...ensemble.map((f) =>
          prisma.rapprochementLigne.create({
            data: { mouvementBancaireId: mouvement.id, cibleType: f.cibleType, cibleId: f.cibleId, montantAffecte: f.montant, origine: "auto_exact" },
          })
        ),
        prisma.mouvementBancaire.update({ where: { id: mouvement.id }, data: { rapprochementStatut: "rapproche" } }),
      ]);
      for (const f of ensemble) facturesUtiliseesMulti.add(f.cibleId);
      dejaUtilises.add(mouvement.id);
      await logRapprochementHistorique(prisma, {
        mouvementBancaireId: mouvement.id,
        action: "rapproche_auto",
        ancienStatut: "non_rapproche",
        nouveauStatut: "rapproche",
        detail: `${ensemble.length} facture(s) : ${ensemble.map((f) => `${f.cibleType}:${f.cibleId}`).join(", ")}`,
      });
      resultat.nbRapprochesMultiFactures++;
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
        await marquerMouvementsAmbigus(prisma, [remise.id], "Remise carte bleue : plusieurs sous-ensembles d'encaissements correspondent exactement au montant.");
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
        await marquerMouvementsAmbigus(prisma, [remise.id], "Remise cheques : plusieurs sous-ensembles d'encaissements correspondent exactement au montant.");
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
        await marquerMouvementsAmbigus(prisma, [mouvement.id], `Virement client "${mouvement.libelle}" : ${candidats.length} encaissements candidats au meme montant.`);
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
    resultat.nbRapprochesArchives > 0 ||
    resultat.nbAmbigusArchives > 0 ||
    resultat.nbRapprochesMultiFactures > 0 ||
    resultat.nbAmbigusMultiFactures > 0 ||
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
      resultat: `Payouts : ${resultat.nbRapproches} rapproche(s), ${resultat.nbAmbigus} ambigu(s), ${resultat.nbSansCorrespondance} sans correspondance. Factures fournisseurs : ${resultat.nbRapprochesFournisseurs} rapprochee(s), ${resultat.nbAmbigusFournisseurs} ambigue(s), ${resultat.nbSansCorrespondanceFournisseurs} sans correspondance. Documents fournisseurs : ${resultat.nbRapprochesDocuments} rapproche(s), ${resultat.nbAmbigusDocuments} ambigu(s), ${resultat.nbSansCorrespondanceDocuments} sans correspondance. Archives comptables hors Dext : ${resultat.nbRapprochesArchives} rapprochee(s), ${resultat.nbAmbigusArchives} ambigue(s), ${resultat.nbSansCorrespondanceArchives} sans correspondance. Reglements multi-factures : ${resultat.nbRapprochesMultiFactures} rapproche(s), ${resultat.nbAmbigusMultiFactures} ambigu(s). Remises carte bleue : ${resultat.nbRapprochesRemisesCb} rapprochee(s), ${resultat.nbAmbigusRemisesCb} ambigue(s), ${resultat.nbSansCorrespondanceRemisesCb} sans correspondance. Remises cheques : ${resultat.nbRapprochesRemisesCheques} rapprochee(s), ${resultat.nbAmbigusRemisesCheques} ambigue(s), ${resultat.nbSansCorrespondanceRemisesCheques} sans correspondance. Virements clients directs : ${resultat.nbRapprochesVirementsClients} rapproche(s), ${resultat.nbAmbigusVirementsClients} ambigu(s), ${resultat.nbSansCorrespondanceVirementsClients} sans correspondance.`,
    });
  }

  return resultat;
}

// --- Validation/annulation manuelle, detail, candidats ---------------------
//
// Complements au moteur automatique ci-dessus (section "Rapprochement
// bancaire" du plan de restructuration) : permettent a l'utilisateur de
// traiter lui-meme un mouvement reste "a_verifier" (ambigu ou reglement
// genuinement partiel) sans jamais deviner a sa place.

function montantEffectifMouvement(mouvement: { debit: number; credit: number; montant: number }): number {
  if (mouvement.debit > 0) return mouvement.debit;
  if (mouvement.credit > 0) return mouvement.credit;
  return Math.abs(mouvement.montant);
}

export interface CibleRapprochementManuel {
  type: "archive_comptable" | "document_fournisseur";
  id: string;
  montantAffecte: number;
}

/**
 * Rattache manuellement une ou plusieurs factures a un mouvement bancaire -
 * gere aussi bien le reglement partiel (une seule facture, montant affecte
 * inferieur a son propre montant) que le reglement multi-factures. Jamais
 * de montant invente : la somme deja affectee (lignes actives existantes +
 * nouvelles cibles) ne peut jamais depasser le montant reel du mouvement
 * (tolerance d'arrondi TOLERANCE_MONTANT). Le mouvement ne repasse
 * "rapproche" que lorsque la somme couvre entierement son montant ; sinon
 * il reste "a_verifier" (reglement partiel assume, jamais cache).
 */
export async function validerRapprochementManuel(
  prisma: PrismaClient,
  mouvementId: string,
  cibles: CibleRapprochementManuel[],
  auteur?: string
) {
  if (cibles.length === 0) throw new Error("Aucune cible fournie.");

  const mouvement = await prisma.mouvementBancaire.findUnique({ where: { id: mouvementId } });
  if (!mouvement) throw new Error("Mouvement bancaire introuvable.");

  const montantMouvement = montantEffectifMouvement(mouvement);
  const lignesActives = await prisma.rapprochementLigne.findMany({ where: { mouvementBancaireId: mouvementId, annuleLe: null } });
  const dejaAffecte = lignesActives.reduce((somme, l) => somme + l.montantAffecte, 0);
  const nouveauTotal = dejaAffecte + cibles.reduce((somme, c) => somme + c.montantAffecte, 0);

  if (nouveauTotal > montantMouvement + TOLERANCE_MONTANT) {
    throw new Error(
      `Le montant total affecté (${nouveauTotal.toFixed(2)} €) dépasserait le montant du mouvement (${montantMouvement.toFixed(2)} €).`
    );
  }

  const couvertEntierement = nouveauTotal >= montantMouvement - TOLERANCE_MONTANT;
  const nouveauStatut = couvertEntierement ? "rapproche" : "a_verifier";

  await prisma.$transaction([
    ...cibles.map((c) =>
      prisma.rapprochementLigne.create({
        data: { mouvementBancaireId: mouvementId, cibleType: c.type, cibleId: c.id, montantAffecte: c.montantAffecte, origine: "manuel", auteur },
      })
    ),
    // Cas simple (une seule cible qui couvre exactement le mouvement) : pose
    // aussi le champ scalaire mouvementBancaireId direct, pour que les
    // passes automatiques ci-dessus (qui filtrent deja mouvementBancaireId:
    // null) l'excluent naturellement d'un futur rapprochement. Un reglement
    // partiel ou multi-factures reste uniquement trace via
    // RapprochementLigne (le champ scalaire ne peut representer qu'un lien
    // 1-pour-1).
    ...(cibles.length === 1 && lignesActives.length === 0 && couvertEntierement
      ? [
          cibles[0].type === "archive_comptable"
            ? prisma.archiveComptable.update({ where: { id: cibles[0].id }, data: { mouvementBancaireId: mouvementId } })
            : prisma.documentFournisseur.update({ where: { id: cibles[0].id }, data: { mouvementBancaireId: mouvementId } }),
        ]
      : []),
    prisma.mouvementBancaire.update({ where: { id: mouvementId }, data: { rapprochementStatut: nouveauStatut } }),
  ]);

  await logRapprochementHistorique(prisma, {
    mouvementBancaireId: mouvementId,
    action: "rapproche_manuel",
    ancienStatut: mouvement.rapprochementStatut,
    nouveauStatut,
    detail: `${cibles.length} cible(s) ajoutée(s) manuellement, total affecté ${nouveauTotal.toFixed(2)} € sur ${montantMouvement.toFixed(2)} €.`,
    auteur,
  });

  return { statut: nouveauStatut, montantAffecteTotal: nouveauTotal, montantMouvement };
}

/**
 * Annulation controlee d'un rapprochement (manuel ou automatique) - jamais
 * de DELETE (demande explicite : conserver l'historique integral) : les
 * lignes RapprochementLigne actives sont soft-cancel (annuleLe/annulePar),
 * et seuls les liens pointant PRECISEMENT vers ce mouvement sont retires
 * (chaque updateMany est filtre sur mouvementBancaireId === mouvementId),
 * jamais ceux d'un autre mouvement.
 */
export async function annulerRapprochementManuel(prisma: PrismaClient, mouvementId: string, auteur?: string) {
  const mouvement = await prisma.mouvementBancaire.findUnique({ where: { id: mouvementId } });
  if (!mouvement) throw new Error("Mouvement bancaire introuvable.");

  const lignesActives = await prisma.rapprochementLigne.findMany({ where: { mouvementBancaireId: mouvementId, annuleLe: null } });

  await prisma.$transaction([
    ...lignesActives.map((l) =>
      prisma.rapprochementLigne.update({ where: { id: l.id }, data: { annuleLe: new Date(), annulePar: auteur ?? null } })
    ),
    prisma.payout.updateMany({ where: { mouvementBancaireId: mouvementId }, data: { mouvementBancaireId: null } }),
    prisma.archiveComptable.updateMany({ where: { mouvementBancaireId: mouvementId }, data: { mouvementBancaireId: null } }),
    prisma.documentFournisseur.updateMany({ where: { mouvementBancaireId: mouvementId }, data: { mouvementBancaireId: null } }),
    prisma.encaissement.updateMany({ where: { mouvementBancaireId: mouvementId }, data: { mouvementBancaireId: null } }),
    prisma.mouvementBancaire.update({ where: { id: mouvementId }, data: { rapprochementStatut: "non_rapproche" } }),
  ]);

  await logRapprochementHistorique(prisma, {
    mouvementBancaireId: mouvementId,
    action: "annule_manuel",
    ancienStatut: mouvement.rapprochementStatut,
    nouveauStatut: "non_rapproche",
    auteur,
  });
}

/**
 * Detail complet d'un mouvement : facture(s) liee(s) (via RapprochementLigne
 * pour un reglement partiel/multi-factures, ou via le champ scalaire
 * mouvementBancaireId pour le cas simple 1-pour-1 des passes automatiques
 * "classiques"), payouts/encaissements lies, et historique - alimente
 * l'interface de detail/validation manuelle.
 */
export async function obtenirDetailMouvement(prisma: PrismaClient, mouvementId: string) {
  const mouvement = await prisma.mouvementBancaire.findUnique({ where: { id: mouvementId } });
  if (!mouvement) throw new Error("Mouvement bancaire introuvable.");

  const [lignes, historique] = await Promise.all([
    prisma.rapprochementLigne.findMany({ where: { mouvementBancaireId: mouvementId, annuleLe: null }, orderBy: { createdAt: "asc" } }),
    prisma.rapprochementHistorique.findMany({ where: { mouvementBancaireId: mouvementId }, orderBy: { createdAt: "asc" } }),
  ]);

  const archiveIds = lignes.filter((l) => l.cibleType === "archive_comptable").map((l) => l.cibleId);
  const documentIds = lignes.filter((l) => l.cibleType === "document_fournisseur").map((l) => l.cibleId);

  const [archivesLiees, documentsLiees, archivesSimples, documentsSimples, payouts, encaissements] = await Promise.all([
    archiveIds.length > 0 ? prisma.archiveComptable.findMany({ where: { id: { in: archiveIds } } }) : Promise.resolve([]),
    documentIds.length > 0 ? prisma.documentFournisseur.findMany({ where: { id: { in: documentIds } } }) : Promise.resolve([]),
    prisma.archiveComptable.findMany({ where: { mouvementBancaireId: mouvementId } }),
    prisma.documentFournisseur.findMany({ where: { mouvementBancaireId: mouvementId } }),
    prisma.payout.findMany({ where: { mouvementBancaireId: mouvementId } }),
    prisma.encaissement.findMany({ where: { mouvementBancaireId: mouvementId } }),
  ]);

  const cibles = [
    ...lignes.map((l) => ({
      origine: l.origine,
      cibleType: l.cibleType,
      cibleId: l.cibleId,
      montantAffecte: l.montantAffecte,
      detail: l.cibleType === "archive_comptable" ? archivesLiees.find((a) => a.id === l.cibleId) : documentsLiees.find((d) => d.id === l.cibleId),
    })),
    // Cas simple (sans RapprochementLigne, lien pose uniquement via le champ
    // scalaire par l'une des passes automatiques "classiques" ci-dessus).
    ...archivesSimples
      .filter((a) => !archiveIds.includes(a.id))
      .map((a) => ({ origine: "auto_exact", cibleType: "archive_comptable" as const, cibleId: a.id, montantAffecte: a.montantTTC ?? 0, detail: a })),
    ...documentsSimples
      .filter((d) => !documentIds.includes(d.id))
      .map((d) => ({ origine: "auto_exact", cibleType: "document_fournisseur" as const, cibleId: d.id, montantAffecte: d.montantTTC ?? 0, detail: d })),
  ];

  return { mouvement, cibles, payouts, encaissements, historique };
}

/**
 * Factures (ArchiveComptable/DocumentFournisseur) pas encore rapprochees,
 * dans la meme fenetre de dates que les passes automatiques debit - alimente
 * l'outil de rattachement manuel (hand-pick) sans dupliquer cette logique de
 * fenetre cote client.
 */
export async function obtenirCandidatsMouvement(prisma: PrismaClient, mouvementId: string) {
  const mouvement = await prisma.mouvementBancaire.findUnique({ where: { id: mouvementId } });
  if (!mouvement) throw new Error("Mouvement bancaire introuvable.");

  const [archives, documents] = await Promise.all([
    prisma.archiveComptable.findMany({ where: { montantTTC: { not: null }, dateFacture: { not: null }, mouvementBancaireId: null } }),
    prisma.documentFournisseur.findMany({ where: { type: "facture", montantTTC: { not: null }, mouvementBancaireId: null } }),
  ]);

  const dansLaFenetre = (date: Date) => differenceJours(date, mouvement.date) <= FENETRE_JOURS_FACTURE_FOURNISSEUR;

  return {
    archives: archives.filter((a) => dansLaFenetre(a.dateFacture as Date)),
    documents: documents.filter((d) => {
      const date = d.date ?? d.dateReceptionMail;
      return date !== null && dansLaFenetre(date);
    }),
  };
}
