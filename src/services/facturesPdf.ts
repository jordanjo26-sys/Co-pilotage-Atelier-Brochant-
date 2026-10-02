import { genererPdfTableau, fmtMontantPdf, fmtDatePdf } from "./pdfTableau";

/**
 * Export PDF des factures impayées (demande explicite de l'utilisateur,
 * après avoir constaté que Morgane ne peut pas le faire — son jeu d'outils
 * est volontairement limité à des actions/requêtes précises, jamais à la
 * génération de documents).
 */
export interface LigneFacturePdf {
  reference: string;
  clientNom: string;
  dateEcheance: Date | null;
  montantTTC: number;
  montantRegle: number;
}

export function genererPdfFacturesImpayees(factures: LigneFacturePdf[]): Promise<Buffer> {
  const totalResteAPercevoir = factures.reduce((s, f) => s + (f.montantTTC - f.montantRegle), 0);
  return genererPdfTableau(
    "Factures impayées — Atelier Brochant",
    `Généré le ${new Date().toLocaleDateString("fr-FR")} — ${factures.length} facture(s)`,
    [
      { label: "Référence", largeur: 85, valeur: (f: LigneFacturePdf) => f.reference },
      { label: "Client", largeur: 155, valeur: (f: LigneFacturePdf) => f.clientNom },
      { label: "Échéance", largeur: 75, valeur: (f: LigneFacturePdf) => fmtDatePdf(f.dateEcheance) },
      { label: "Montant TTC", largeur: 90, valeur: (f: LigneFacturePdf) => fmtMontantPdf(f.montantTTC) },
      { label: "Reste à percevoir", largeur: 100, valeur: (f: LigneFacturePdf) => fmtMontantPdf(f.montantTTC - f.montantRegle) },
    ],
    factures,
    `Total restant à percevoir : ${fmtMontantPdf(totalResteAPercevoir)}`
  );
}
