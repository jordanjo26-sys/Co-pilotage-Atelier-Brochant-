import PDFDocument from "pdfkit";

/**
 * Génération générique d'un PDF "tableau simple" (titre, en-tête de
 * colonnes, lignes, pagination automatique, pied de page optionnel).
 * Factorisé après l'ajout d'un deuxième export PDF (paiements Stripe, en
 * plus des factures impayées) pour ne pas dupliquer la mécanique pdfkit
 * (positionnement des colonnes, saut de page) une deuxième fois.
 */
export interface ColonnePdf<T> {
  label: string;
  largeur: number;
  valeur: (ligne: T) => string;
}

export async function genererPdfTableau<T>(
  titre: string,
  sousTitre: string,
  colonnes: ColonnePdf<T>[],
  lignes: T[],
  pied?: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const morceaux: Buffer[] = [];
    doc.on("data", (m) => morceaux.push(m));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);

    const margeGauche = doc.page.margins.left;
    const limiteBas = doc.page.height - doc.page.margins.bottom;
    const hauteurLigne = 20;
    const largeurTotale = colonnes.reduce((s, c) => s + c.largeur, 0);

    doc.fontSize(16).fillColor("#16213E").text(titre, { align: "left" });
    doc.fontSize(9).fillColor("#78829C").text(sousTitre);
    doc.moveDown(1.2);

    const dessinerEntete = () => {
      // y fixe pour toutes les colonnes de la ligne : doc.text() avance le
      // curseur interne apres chaque appel, donc relire doc.y a chaque
      // colonne decale les colonnes suivantes vers le bas des que l'une
      // d'elles occupe plus d'une ligne (bug reel, corrige une fois).
      let x = margeGauche;
      const y = doc.y;
      doc.fontSize(9).fillColor("#78829C");
      for (const col of colonnes) {
        doc.text(col.label, x, y, { width: col.largeur, continued: false });
        x += col.largeur;
      }
      doc.y = y + 14;
      doc.moveDown(0.3);
      doc.moveTo(margeGauche, doc.y).lineTo(margeGauche + largeurTotale, doc.y).strokeColor("#E2E7F1").stroke();
      doc.moveDown(0.3);
    };

    dessinerEntete();

    for (const ligne of lignes) {
      if (doc.y + hauteurLigne > limiteBas) {
        doc.addPage();
        dessinerEntete();
      }
      let x = margeGauche;
      const y = doc.y;
      doc.fontSize(9).fillColor("#16213E");
      for (const col of colonnes) {
        doc.text(col.valeur(ligne), x, y, { width: col.largeur });
        x += col.largeur;
      }
      doc.y = y + hauteurLigne;
    }

    if (pied) {
      doc.moveDown(0.5);
      doc.moveTo(margeGauche, doc.y).lineTo(margeGauche + largeurTotale, doc.y).strokeColor("#E2E7F1").stroke();
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor("#16213E").text(pied, margeGauche);
    }

    doc.end();
  });
}

export const fmtMontantPdf = (n: number) => `${n.toFixed(2).replace(".", ",")} €`;
export const fmtDatePdf = (d: Date | null) => (d ? d.toLocaleDateString("fr-FR") : "—");
