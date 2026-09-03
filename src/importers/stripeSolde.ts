import { PrismaClient } from "@prisma/client";
import { parseAmount } from "./csvUtils";
import { ImportRowError } from "./types";
import { RowImportResult } from "./synecFactures";

/**
 * Importe un recapitulatif de solde Stripe periodique (section 20 du
 * cahier des charges : "Exports Stripe, dont payouts et recapitulatif de
 * solde"). Chaque ligne est une categorie deja agregee par Stripe
 * (starting_balance, activity, payouts, ending_balance...) : c'est un
 * repere d'audit pour verifier la coherence des paiements/payouts
 * detailles, pas une source de verite transactionnelle a elle seule.
 */
export async function importStripeSolde(
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
      const categorie = row[resolvedColumns.categorie]?.trim();
      const libelle = row[resolvedColumns.libelle]?.trim();
      const montantNet = parseAmount(row[resolvedColumns.montantNet]);

      if (!categorie) {
        erreurs.push({ ligne, message: "Categorie manquante." });
        continue;
      }
      if (!libelle) {
        erreurs.push({ ligne, message: "Libelle manquant." });
        continue;
      }
      if (montantNet === null) {
        erreurs.push({ ligne, message: "Montant illisible." });
        continue;
      }

      const existing = await prisma.recapitulatifSolde.findUnique({
        where: { categorie_libelle: { categorie, libelle } },
      });

      const data = {
        montantNet,
        devise: resolvedColumns.devise ? row[resolvedColumns.devise] || "EUR" : "EUR",
        sourceImportId: importBatchId,
      };

      if (existing) {
        await prisma.recapitulatifSolde.update({
          where: { categorie_libelle: { categorie, libelle } },
          data,
        });
        nbDoublons++;
      } else {
        await prisma.recapitulatifSolde.create({ data: { categorie, libelle, ...data } });
        nbNouveaux++;
      }
    } catch (err) {
      erreurs.push({ ligne, message: (err as Error).message });
    }
  }

  return { nbNouveaux, nbDoublons, erreurs };
}
