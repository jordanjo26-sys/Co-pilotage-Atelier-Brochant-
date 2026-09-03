import { PrismaClient } from "@prisma/client";
import { ImportRowError } from "./types";
import { RowImportResult } from "./synecFactures";

function composeAdresse(l1?: string, l2?: string, l3?: string): string | null {
  const lignes = [l1, l2, l3].map((l) => (l || "").trim()).filter(Boolean);
  return lignes.length > 0 ? lignes.join(", ") : null;
}

/**
 * Importe l'export clients Synec (identite, coordonnees, adresse - section
 * 15 du cahier des charges). Enrichit les fiches deja creees par
 * l'import des factures (qui ne connaissent qu'un nom) avec l'email, le
 * telephone et l'adresse, en zero double saisie : aucune ressaisie
 * manuelle necessaire cote copilote.
 */
export async function importSynecClients(
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
      const synecId = row[resolvedColumns.synecId]?.trim();
      const nom = row[resolvedColumns.nom]?.trim();

      if (!synecId) {
        erreurs.push({ ligne, message: "Identifiant client Synec manquant." });
        continue;
      }
      if (!nom) {
        erreurs.push({ ligne, message: "Nom client manquant." });
        continue;
      }

      const data = {
        nom,
        email: resolvedColumns.email ? row[resolvedColumns.email]?.trim() || null : null,
        telephone: resolvedColumns.telephone ? row[resolvedColumns.telephone]?.trim() || null : null,
        type: resolvedColumns.type ? row[resolvedColumns.type]?.trim() || null : null,
        source: resolvedColumns.source ? row[resolvedColumns.source]?.trim() || null : null,
        adresse: composeAdresse(
          resolvedColumns.adresse1 ? row[resolvedColumns.adresse1] : undefined,
          resolvedColumns.adresse2 ? row[resolvedColumns.adresse2] : undefined,
          resolvedColumns.adresse3 ? row[resolvedColumns.adresse3] : undefined
        ),
        codePostal: resolvedColumns.codePostal ? row[resolvedColumns.codePostal]?.trim() || null : null,
        ville: resolvedColumns.ville ? row[resolvedColumns.ville]?.trim() || null : null,
        pays: resolvedColumns.pays ? row[resolvedColumns.pays]?.trim() || null : null,
        sourceImportId: importBatchId,
      };

      const existing = await prisma.client.findUnique({ where: { synecId } });

      if (existing) {
        await prisma.client.update({ where: { synecId }, data });
        nbDoublons++;
        continue;
      }

      // Repli : un Client peut deja exister sans synecId (cree par un
      // import de factures anterieur, qui ne connait le client que par
      // son nom). On le retrouve et on le complete plutot que d'en
      // recreer un doublon.
      const parNom = await prisma.client.findFirst({ where: { nom, synecId: null } });
      if (parNom) {
        await prisma.client.update({ where: { id: parNom.id }, data: { synecId, ...data } });
        nbDoublons++;
        continue;
      }

      await prisma.client.create({ data: { synecId, ...data } });
      nbNouveaux++;
    } catch (err) {
      erreurs.push({ ligne, message: (err as Error).message });
    }
  }

  return { nbNouveaux, nbDoublons, erreurs };
}
