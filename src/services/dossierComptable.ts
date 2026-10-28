import { PrismaClient } from "@prisma/client";
import { executerRapprochementBancaire } from "./rapprochementBancaire";
import { genererDocumentPdf, ResultatDocumentGenere, SectionDocumentGenere } from "./documentsGeneres";

/**
 * Dossier comptable : photographie de l'etat du rapprochement bancaire
 * (payouts Stripe + factures fournisseurs, voir rapprochementBancaire.ts),
 * mise en forme en PDF pour etre transmise telle quelle au comptable.
 * Demande explicite de l'utilisateur ("rapprochement au Comptable") :
 * au-dela de la simple verification interne (verifier_rapprochement_bancaire),
 * produire un document pret a envoyer plutot que de laisser l'utilisateur
 * reconstituer lui-meme la liste depuis l'application.
 *
 * Relance d'abord le rapprochement (gratuit, idempotent) pour que le
 * dossier reflete l'etat le plus a jour possible, puis liste ce qui reste
 * en attente d'explication - c'est precisement ce qu'un comptable a besoin
 * de voir, pas la liste de tout ce qui est deja rapproche et donc sans
 * question a se poser.
 */

function formaterMontant(montant: number): string {
  return `${montant.toFixed(2).replace(".", ",")} €`;
}

function formaterDate(date: Date | null): string {
  return date ? date.toLocaleDateString("fr-FR") : "date inconnue";
}

export async function genererDossierComptable(prisma: PrismaClient): Promise<ResultatDocumentGenere> {
  const resume = await executerRapprochementBancaire(prisma);

  const [payoutsEnAttente, facturesEnAttente, mouvementsNonExpliques, nbPayoutsRapprochesTotal, nbFacturesRapprocheesTotal] = await Promise.all([
    prisma.payout.findMany({ where: { mouvementBancaireId: null }, orderBy: { date: "desc" } }),
    prisma.factureFournisseur.findMany({
      where: { statut: "a_payer", mouvementBancaireId: null },
      include: { fournisseur: true },
      orderBy: { echeance: "asc" },
    }),
    prisma.mouvementBancaire.findMany({ where: { rapprochementStatut: "non_rapproche" }, orderBy: { date: "desc" } }),
    prisma.payout.count({ where: { mouvementBancaireId: { not: null } } }),
    prisma.factureFournisseur.count({ where: { mouvementBancaireId: { not: null } } }),
  ]);

  const sections: SectionDocumentGenere[] = [];

  sections.push({
    titre: "Resume",
    paragraphes: [
      `${nbPayoutsRapprochesTotal} encaissement(s) Stripe rapproche(s) avec le releve bancaire, ${payoutsEnAttente.length} en attente.`,
      `${nbFacturesRapprocheesTotal} facture(s) fournisseur rapprochee(s) avec le releve bancaire, ${facturesEnAttente.length} encore a payer et non rapprochee(s).`,
      `${mouvementsNonExpliques.length} ligne(s) du releve bancaire sans encaissement ni facture fournisseur correspondant - a verifier (frais bancaires, prelevement non suivi dans l'application, etc.).`,
    ],
  });

  if (payoutsEnAttente.length > 0) {
    sections.push({
      titre: "Encaissements Stripe en attente de rapprochement",
      puces: payoutsEnAttente.map(
        (p) => `${formaterDate(p.date)} - ${formaterMontant(p.montantNet)} - ref. ${p.payoutRef}${p.destinationName ? ` (${p.destinationName})` : ""}`
      ),
    });
  }

  if (facturesEnAttente.length > 0) {
    sections.push({
      titre: "Factures fournisseurs en attente de paiement/rapprochement",
      puces: facturesEnAttente.map((f) => {
        const fournisseurNom = f.fournisseur?.nom ?? "fournisseur inconnu";
        const ref = f.reference ? ` - ref. ${f.reference}` : "";
        return `${fournisseurNom} - ${formaterMontant(f.montant)} - echeance ${formaterDate(f.echeance)}${ref}`;
      }),
    });
  }

  if (mouvementsNonExpliques.length > 0) {
    sections.push({
      titre: "Mouvements bancaires non expliques",
      puces: mouvementsNonExpliques.map((m) => `${formaterDate(m.date)} - ${formaterMontant(m.montant)} - ${m.libelle}`),
    });
  }

  const titre = `Dossier comptable - ${new Date().toLocaleDateString("fr-FR")}`;
  return genererDocumentPdf(prisma, { titre, sections });
}
