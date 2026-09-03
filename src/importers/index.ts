import { PrismaClient } from "@prisma/client";
import { importSynecFactures, RowImportResult } from "./synecFactures";
import { importStripePayments } from "./stripePayments";
import { importStripePayouts } from "./stripePayouts";
import { importStripeSolde } from "./stripeSolde";
import { importBankStatement } from "./bankStatement";

type Normalizer = (
  prisma: PrismaClient,
  rows: Record<string, string>[],
  resolvedColumns: Record<string, string>,
  importBatchId: string
) => Promise<RowImportResult>;

/**
 * Registre des normalisateurs disponibles, indexe par le champ "type" des
 * fichiers de mapping (src/config/mappings/*.json). Ajouter un nouveau type
 * de CSV = ajouter un fichier de mapping + un normalisateur ici.
 */
export const NORMALIZERS: Record<string, Normalizer> = {
  synec_factures: importSynecFactures,
  stripe_paiements: importStripePayments,
  stripe_payouts: importStripePayouts,
  stripe_solde: importStripeSolde,
  banque_releve: importBankStatement,
};

export { RowImportResult };
