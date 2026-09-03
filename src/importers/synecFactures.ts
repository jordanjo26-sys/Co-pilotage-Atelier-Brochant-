import { PrismaClient } from "@prisma/client";
import { parseAmount, parseFlexibleDate } from "./csvUtils";
import { ImportRowError } from "./types";

export interface RowImportResult {
  nbNouveaux: number;
  nbDoublons: number;
  erreurs: ImportRowError[];
}

export interface ReglementParse {
  montantRegle: number;
  modes: string[];
  oney: boolean;
}

/**
 * L'export Synec reel n'a pas de colonne statut/echeance/mode de paiement :
 * tout est reconstitue a partir de la colonne "payments", qui empile un ou
 * plusieurs reglements au format "date|montant|mode|note", separes par
 * " // " lorsqu'une facture est reglee en plusieurs fois. Exemple observe :
 * "2025-03-31 15:39:44|500,00 €|Carte| // 2025-03-31 15:39:57|437,43 €|Chèque|"
 */
export function parseReglements(raw: string | undefined): ReglementParse {
  const result: ReglementParse = { montantRegle: 0, modes: [], oney: false };
  if (!raw || raw.trim() === "") return result;

  const entries = raw.split("//").map((e) => e.trim()).filter(Boolean);
  for (const entry of entries) {
    const parts = entry.split("|");
    const montant = parseAmount(parts[1]);
    const mode = (parts[2] || "").trim();
    const note = (parts[3] || "").trim();

    if (montant !== null) result.montantRegle += montant;
    if (mode && !result.modes.includes(mode)) result.modes.push(mode);
    if (/oney/i.test(mode) || /oney/i.test(note)) result.oney = true;
  }

  return result;
}

export function deriveStatut(montantTTC: number, montantRegle: number): "payee" | "partiellement_payee" | "impayee" {
  const tolerance = 0.02;
  if (montantRegle >= montantTTC - tolerance) return "payee";
  if (montantRegle > tolerance) return "partiellement_payee";
  return "impayee";
}

function parseBooleanish(raw: string | undefined): boolean {
  const s = (raw || "").trim().toLowerCase();
  return ["oui", "yes", "true", "1", "x", "cloture", "cloturee"].includes(s);
}

/**
 * Importe un export CSV de factures Synec (sections 3, 4 et 15 du cahier
 * des charges). Chaque ligne devient (ou met a jour) une Facture, rattachee
 * a un Client cree/retrouve par son nom.
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

      // Date d'emission : priorite a la date comptable, repli sur la date
      // de creation si absente ou sentinelle invalide (ex. "0000-00-00").
      const dateAccounting = resolvedColumns.dateAccounting
        ? parseFlexibleDate(row[resolvedColumns.dateAccounting])
        : null;
      const dateCreation = resolvedColumns.dateCreation
        ? parseFlexibleDate(row[resolvedColumns.dateCreation])
        : null;
      const dateEmission = dateAccounting ?? dateCreation;

      const montantHT = resolvedColumns.montantHT ? parseAmount(row[resolvedColumns.montantHT]) : null;

      const { montantRegle, modes, oney } = parseReglements(
        resolvedColumns.payments ? row[resolvedColumns.payments] : undefined
      );
      const statut = deriveStatut(montantTTC, montantRegle);

      const existing = await prisma.facture.findUnique({ where: { reference } });

      // Client.nom n'est pas unique dans le schema (deux clients distincts
      // peuvent porter le meme nom) : on retrouve par nom, sinon on cree.
      const client =
        (await prisma.client.findFirst({ where: { nom: clientNom } })) ??
        (await prisma.client.create({ data: { nom: clientNom } }));

      const data = {
        clientId: client.id,
        clientNom,
        description: resolvedColumns.description ? row[resolvedColumns.description]?.trim() || null : null,
        dateEmission,
        montantHT,
        montantTTC,
        montantRegle,
        statut,
        modePaiement: modes.length > 0 ? modes.join(", ") : null,
        bonCommande: resolvedColumns.bonCommande ? row[resolvedColumns.bonCommande] || null : null,
        financementOney: oney,
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
