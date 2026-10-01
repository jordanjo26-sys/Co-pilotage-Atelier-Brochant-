import PDFDocument from "pdfkit";

/**
 * Export PDF des factures impayées (demande explicite de l'utilisateur,
 * après avoir constaté que Morgane ne peut pas le faire — son jeu d'outils
 * est volontairement limité à des actions/requêtes précises, jamais à la
 * génération de documents). Une page simple, pas de mise en page
 * sophistiquée : l'objectif est une liste imprimable/partageable, pas un
 * document de présentation.
 */
export interface LigneFacturePdf {
  reference: string;
  clientNom: string;
  dateEcheance: Date | null;
  montantTTC: number;
  montantRegle: number;
}

const COLONNES = [
  { cle: "reference" as const, label: "Référence", largeur: 85 },
  { cle: "clientNom" as const, label: "Client", largeur: 155 },
  { cle: "dateEcheance" as const, label: "Échéance", largeur: 75 },
  { cle: "montantTTC" as const, label: "Montant TTC", largeur: 90 },
  { cle: "resteAPercevoir" as const, label: "Reste à percevoir", largeur: 100 },
];

const fmtMontant = (n: number) => `${n.toFixed(2).replace(".", ",")} €`;
const fmtDate = (d: Date | null) => (d ? d.toLocaleDateString("fr-FR") : "—");

export function genererPdfFacturesImpayees(factures: LigneFacturePdf[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const morceaux: Buffer[] = [];
    doc.on("data", (m) => morceaux.push(m));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);

    const margeGauche = doc.page.margins.left;
    const limiteBas = doc.page.height - doc.page.margins.bottom;
    const hauteurLigne = 20;

    doc
      .fontSize(16)
      .fillColor("#16213E")
      .text("Factures impayées — Atelier Brochant", { align: "left" });
    doc
      .fontSize(9)
      .fillColor("#78829C")
      .text(`Généré le ${new Date().toLocaleDateString("fr-FR")} — ${factures.length} facture(s)`);
    doc.moveDown(1.2);

    const dessinerEntete = () => {
      // y fixe pour toutes les colonnes de la ligne : doc.text() avance le
      // curseur interne apres chaque appel, donc relire doc.y a chaque
      // colonne (comme fait initialement) decale les colonnes suivantes
      // vers le bas des que l'une d'elles occupe plus d'une ligne.
      let x = margeGauche;
      const y = doc.y;
      doc.fontSize(9).fillColor("#78829C");
      for (const col of COLONNES) {
        doc.text(col.label, x, y, { width: col.largeur, continued: false });
        x += col.largeur;
      }
      doc.y = y + 14;
      doc.moveDown(0.3);
      doc
        .moveTo(margeGauche, doc.y)
        .lineTo(margeGauche + COLONNES.reduce((s, c) => s + c.largeur, 0), doc.y)
        .strokeColor("#E2E7F1")
        .stroke();
      doc.moveDown(0.3);
    };

    dessinerEntete();

    let totalResteAPercevoir = 0;

    for (const f of factures) {
      if (doc.y + hauteurLigne > limiteBas) {
        doc.addPage();
        dessinerEntete();
      }
      const resteAPercevoir = f.montantTTC - f.montantRegle;
      totalResteAPercevoir += resteAPercevoir;

      const valeurs: Record<(typeof COLONNES)[number]["cle"], string> = {
        reference: f.reference,
        clientNom: f.clientNom,
        dateEcheance: fmtDate(f.dateEcheance),
        montantTTC: fmtMontant(f.montantTTC),
        resteAPercevoir: fmtMontant(resteAPercevoir),
      };

      let x = margeGauche;
      const yLigne = doc.y;
      doc.fontSize(9).fillColor("#16213E");
      for (const col of COLONNES) {
        doc.text(valeurs[col.cle], x, yLigne, { width: col.largeur });
        x += col.largeur;
      }
      doc.y = yLigne + hauteurLigne;
    }

    doc.moveDown(0.5);
    doc
      .moveTo(margeGauche, doc.y)
      .lineTo(margeGauche + COLONNES.reduce((s, c) => s + c.largeur, 0), doc.y)
      .strokeColor("#E2E7F1")
      .stroke();
    doc.moveDown(0.3);
    doc
      .fontSize(10)
      .fillColor("#16213E")
      .text(`Total restant à percevoir : ${fmtMontant(totalResteAPercevoir)}`, margeGauche);

    doc.end();
  });
}
