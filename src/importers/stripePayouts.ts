import { PrismaClient } from "@prisma/client";
import { parseAmount, parseFlexibleDate } from "./csvUtils";
import { ImportRowError } from "./types";
import { RowImportResult } from "./synecFactures";

/**
 * Importe un export CSV de payouts (virements groupes) Stripe. Chaque payout
 * regroupe plusieurs paiements et sera ensuite rapproche du mouvement
 * Banque Populaire correspondant (section 5.2 du cahier des charges).
 */
export async function importStripePayouts(
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
      const payoutRef = row[resolvedColumns.payoutRef]?.trim();
      const montantNet = parseAmount(row[resolvedColumns.montantNet]);
      const date = parseFlexibleDate(resolvedColumns.date ? row[resolvedColumns.date] : undefined);

      if (!payoutRef) {
        erreurs.push({ ligne, message: "Identifiant de payout Stripe manquant." });
        continue;
      }
      if (montantNet === null) {
        erreurs.push({ ligne, message: "Montant net illisible." });
        continue;
      }
      if (!date) {
        erreurs.push({ ligne, message: "Date de payout illisible." });
        continue;
      }

      const existing = await prisma.payout.findUnique({ where: { payoutRef } });
      const data = {
        date,
        montantNet,
        statut: resolvedColumns.statut ? row[resolvedColumns.statut] || null : null,
        destinationName: resolvedColumns.destinationName ? row[resolvedColumns.destinationName] || null : null,
        balanceTransactionRef: resolvedColumns.balanceTransactionRef
          ? row[resolvedColumns.balanceTransactionRef] || null
          : null,
        sourceImportId: importBatchId,
      };

      if (existing) {
        await prisma.payout.update({ where: { payoutRef }, data });
        nbDoublons++;
      } else {
        await prisma.payout.create({ data: { payoutRef, ...data } });
        nbNouveaux++;
      }
    } catch (err) {
      erreurs.push({ ligne, message: (err as Error).message });
    }
  }

  return { nbNouveaux, nbDoublons, erreurs };
}
