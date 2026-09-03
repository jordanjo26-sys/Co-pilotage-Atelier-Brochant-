import { PrismaClient } from "@prisma/client";
import { parseAmount, parseFlexibleDate } from "./csvUtils";
import { ImportRowError } from "./types";

function parseStatutFacture(raw: string | undefined): "payee" | "impayee" | "cloturee" {
  const s = (raw || "").toLowerCase();
  if (/(cl[ôo]tur)/.test(s)) return "cloturee";
  if (/(pay[ée]e?|r[ée]gl[ée]e?|solde)/.test(s) && !/(non|impay)/.test(s)) return "payee";
  return "impayee";
}

function parseBooleanish(raw: string | undefined): boolean {
  const s = (raw || "").trim().toLowerCase();
  return ["oui", "yes", "true", "1", "x", "cloture", "cloturee"].includes(s);
}

export interface RowImportResult {
  nbNouveaux: number;
  nbDoublons: number;
  erreurs: ImportRowError[];
}

/**
 * Importe un export CSV de factures Synec (section 3 et 15 du cahier des
 * charges). Chaque ligne devient (ou met a jour) une Facture, rattachee a un
 * Client cree/retrouve par son nom.
 *
 * Critere d'acceptation V1 vise : "Le CSV Synec met a jour les factures et
 * permet de calculer le CA de la veille et les impayes."
 */
export async function importSynecFactures(
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
    const ligne = i + 2; // +1 pour l'en-tete, +1 pour l'index base 1

    try {
      const reference = row[resolvedColumns.reference]?.trim();
      const clientNom = row[resolvedColumns.clientNom]?.trim();
      const montantTTC = parseAmount(row[resolvedColumns.montantTTC]);

      if (!reference) {
        erreurs.push({ ligne, message: "Reference de facture manquante." });
        continue;
      }
      if (!clientNom) {
        erreurs.push({ ligne, message: "Nom client manquant." });
        continue;
      }
      if (montantTTC === null) {
        erreurs.push({ ligne, message: "Montant TTC illisible." });
        continue;
      }

      const existing = await prisma.facture.findUnique({ where: { reference } });

      // Client.nom n'est pas unique dans le schema (deux clients distincts
      // peuvent porter le meme nom) : on retrouve par nom, sinon on cree.
      const client =
        (await prisma.client.findFirst({ where: { nom: clientNom } })) ??
        (await prisma.client.create({ data: { nom: clientNom } }));

      const data = {
        clientId: client.id,
        clientNom,
        dateEmission: parseFlexibleDate(row[resolvedColumns.dateEmission]),
        dateEcheance: parseFlexibleDate(row[resolvedColumns.dateEcheance]),
        montantTTC,
        statut: parseStatutFacture(row[resolvedColumns.statut]),
        modePaiement: resolvedColumns.modePaiement ? row[resolvedColumns.modePaiement] || null : null,
        bonCommande: resolvedColumns.bonCommande ? row[resolvedColumns.bonCommande] || null : null,
        clotureSynec: resolvedColumns.cloture ? parseBooleanish(row[resolvedColumns.cloture]) : false,
        sourceImportId: importBatchId,
      };

      if (existing) {
        await prisma.facture.update({ where: { reference }, data });
        nbDoublons++;
      } else {
        await prisma.facture.create({ data: { reference, ...data } });
        nbNouveaux++;
      }
    } catch (err) {
      erreurs.push({ ligne, message: (err as Error).message });
    }
  }

  return { nbNouveaux, nbDoublons, erreurs };
}
