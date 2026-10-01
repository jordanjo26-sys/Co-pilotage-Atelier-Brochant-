import { genererPdfTableau, fmtMontantPdf, fmtDatePdf } from "./pdfTableau";

/**
 * Export PDF des paiements captés (Stripe — en ligne et Tap to Pay),
 * demandé par l'utilisateur à la suite de l'export PDF des factures
 * impayées. Même mécanisme de génération, voir pdfTableau.ts.
 */
export interface LignePaiementPdf {
  date: Date;
  net: number;
  moyenPaiement: string | null;
  description: string | null;
}

// Meme libelle que LIBELLE_MOYEN_PAIEMENT dans public/app.js (section
// Stripe de l'onglet Trésorerie) : garder les deux synchronises si l'un
// des deux change.
const LIBELLE_MOYEN_PAIEMENT: Record<string, string> = {
  card_present: "Tap to Pay / terminal",
  card: "Carte en ligne",
};

export function genererPdfPaiements(paiements: LignePaiementPdf[]): Promise<Buffer> {
  const totalNet = paiements.reduce((s, p) => s + p.net, 0);
  return genererPdfTableau(
    "Paiements captés — Atelier Brochant",
    `Généré le ${new Date().toLocaleDateString("fr-FR")} — ${paiements.length} paiement(s)`,
    [
      { label: "Date", largeur: 70, valeur: (p: LignePaiementPdf) => fmtDatePdf(p.date) },
      { label: "Montant net", largeur: 80, valeur: (p: LignePaiementPdf) => fmtMontantPdf(p.net) },
      {
        label: "Moyen de paiement",
        largeur: 110,
        valeur: (p: LignePaiementPdf) => (p.moyenPaiement ? LIBELLE_MOYEN_PAIEMENT[p.moyenPaiement] || p.moyenPaiement : "—"),
      },
      { label: "Description", largeur: 165, valeur: (p: LignePaiementPdf) => p.description || "—" },
    ],
    paiements,
    `Total net : ${fmtMontantPdf(totalNet)}`
  );
}
