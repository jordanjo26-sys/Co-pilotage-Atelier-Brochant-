import { PrismaClient } from "@prisma/client";
import { parseAmount, parseFlexibleDate } from "./csvUtils";
import { ImportRowError } from "./types";
import { RowImportResult } from "./synecFactures";

/**
 * Importe un export CSV de paiements Stripe (section 5 du cahier des
 * charges). Conserve montant brut, frais, net, identifiant de paiement et
 * identifiant de payout afin de permettre la ventilation d'un virement
 * groupe jusqu'aux factures clients.
 */
export async function importStripePayments(
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
      const paymentRef = row[resolvedColumns.paymentRef]?.trim();
      const brut = parseAmount(row[resolvedColumns.brut]);
      const date = parseFlexibleDate(resolvedColumns.date ? row[resolvedColumns.date] : undefined);

      if (!paymentRef) {
        erreurs.push({ ligne, message: "Identifiant de paiement Stripe manquant." });
        continue;
      }
      if (brut === null) {
        erreurs.push({ ligne, message: "Montant brut illisible." });
        continue;
      }
      if (!date) {
        erreurs.push({ ligne, message: "Date de paiement illisible." });
        continue;
      }

      const frais = resolvedColumns.frais ? parseAmount(row[resolvedColumns.frais]) ?? 0 : 0;
      const netBrut = resolvedColumns.net ? parseAmount(row[resolvedColumns.net]) : null;
      const net = netBrut ?? brut - frais;

      const existing = await prisma.paiement.findUnique({ where: { paymentRef } });

      const data = {
        source: "stripe",
        brut,
        frais,
        net,
        devise: resolvedColumns.devise ? row[resolvedColumns.devise] || "EUR" : "EUR",
        date,
        clientEmail: resolvedColumns.clientEmail ? row[resolvedColumns.clientEmail] || null : null,
        payoutRef: resolvedColumns.payoutRef ? row[resolvedColumns.payoutRef] || null : null,
        sourceImportId: importBatchId,
      };

      if (existing) {
        await prisma.paiement.update({ where: { paymentRef }, data });
        nbDoublons++;
      } else {
        await prisma.paiement.create({ data: { paymentRef, ...data } });
        nbNouveaux++;
      }
    } catch (err) {
      erreurs.push({ ligne, message: (err as Error).message });
    }
  }

  return { nbNouveaux, nbDoublons, erreurs };
}
