import { PrismaClient } from "@prisma/client";
import { parseAmount, parseFlexibleDate } from "./csvUtils";
import { hashBankRow } from "../services/hash";
import { ImportRowError } from "./types";
import { RowImportResult } from "./synecFactures";

/**
 * Importe un releve de compte bancaire (Banque Populaire ou autre) au
 * format CSV. En l'absence d'identifiant unique fourni par la banque, la
 * detection de doublon repose sur une empreinte (date + libelle + montant).
 */
export async function importBankStatement(
  prisma: PrismaClient,
  rows: Record<string, string>[],
  resolvedColumns: Record<string, string>,
  importBatchId: string
): Promise<RowImportResult> {
  let nbNouveaux = 0;
  let nbDoublons = 0;
  const erreurs: ImportRowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ligne = i + 2;

    try {
      const dateRaw = row[resolvedColumns.date];
      const date = parseFlexibleDate(dateRaw);
      const libelle = row[resolvedColumns.libelle]?.trim();

      if (!date) {
        erreurs.push({ ligne, message: "Date illisible." });
        continue;
      }
      if (!libelle) {
        erreurs.push({ ligne, message: "Libelle manquant." });
        continue;
      }

      let debit = resolvedColumns.debit ? parseAmount(row[resolvedColumns.debit]) ?? 0 : 0;
      let credit = resolvedColumns.credit ? parseAmount(row[resolvedColumns.credit]) ?? 0 : 0;
      let montant = resolvedColumns.montant ? parseAmount(row[resolvedColumns.montant]) : null;
      // Montant BRUT d'une remise carte bleue (colonne "montantBrut"
      // optionnelle - voir receivePdfBankStatement / PdfTransaction.montantBrut).
      const montantBrut = resolvedColumns.montantBrut
        ? parseAmount(row[resolvedColumns.montantBrut])
        : null;

      if (montant === null) {
        montant = credit - debit;
      } else if (!resolvedColumns.debit && !resolvedColumns.credit) {
        // Une seule colonne "montant" signee : on en deduit debit/credit.
        if (montant >= 0) {
          credit = montant;
        } else {
          debit = Math.abs(montant);
        }
      }

      // Cle de dedoublonnage distincte du libelle affiche, quand fournie
      // (colonne "cleHash" optionnelle - voir receivePdfBankStatement) :
      // deux operations peuvent partager exactement date+libelle+montant
      // sur un vrai releve (ex. plusieurs prelevements de rattrapage le
      // meme jour, meme montant) sans etre un doublon d'import.
      const cleHash = resolvedColumns.cleHash ? row[resolvedColumns.cleHash] : libelle;
      const hashLigne = hashBankRow(dateRaw.trim(), cleHash, montant);
      const existing = await prisma.mouvementBancaire.findUnique({ where: { hashLigne } });

      if (existing) {
        nbDoublons++;
        continue;
      }

      await prisma.mouvementBancaire.create({
        data: {
          date,
          libelle,
          debit,
          credit,
          montant,
          montantBrut: montantBrut ?? undefined,
          hashLigne,
          sourceImportId: importBatchId,
        },
      });
      nbNouveaux++;
    } catch (err) {
      erreurs.push({ ligne, message: (err as Error).message });
    }
  }

  return { nbNouveaux, nbDoublons, erreurs };
}
