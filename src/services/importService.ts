import { PrismaClient } from "@prisma/client";
import { parseCsvBuffer } from "../importers/csvUtils";
import { detectCsvType } from "../importers/detect";
import { NORMALIZERS } from "../importers/index";
import { sha256Hex } from "./hash";
import { ImportSummary } from "../importers/types";
import { logEvenement } from "./journalService";

/**
 * Point d'entree unique de la reception d'un fichier CSV : detection du
 * type, controle de doublon au niveau du fichier, dispatch vers le bon
 * normalisateur, puis enregistrement du lot d'import et du journal.
 *
 * Reprend le pipeline documentaire de la section 7.2 du cahier des charges,
 * adapte aux imports CSV (au lieu des pieces jointes Gmail) : detecter,
 * classifier, controler les doublons, traiter ou mettre en attente si
 * ambigu, journaliser.
 */
export async function receiveCsv(
  prisma: PrismaClient,
  fichierNom: string,
  buffer: Buffer
): Promise<ImportSummary> {
  const hashFichier = sha256Hex(buffer);

  const dejaImporte = await prisma.importBatch.findUnique({ where: { hashFichier } });
  if (dejaImporte) {
    await logEvenement(prisma, {
      evenement: "import_csv",
      action: `Depot de ${fichierNom}`,
      resultat: `Fichier deja importe le ${dejaImporte.dateImport.toISOString()} (lot ${dejaImporte.id})`,
    });
    return {
      fichierNom,
      typeDetecte: dejaImporte.typeDetecte,
      statut: "doublon_fichier",
      nbLignes: dejaImporte.nbLignes,
      nbNouveaux: 0,
      nbDoublons: dejaImporte.nbLignes,
      nbErreurs: 0,
      erreurs: [],
      importBatchId: dejaImporte.id,
    };
  }

  const { headers, normalizedHeaders, rows } = parseCsvBuffer(buffer);

  if (headers.length === 0) {
    const batch = await prisma.importBatch.create({
      data: { fichierNom, typeDetecte: "inconnu", hashFichier, statut: "echec", nbLignes: 0 },
    });
    await logEvenement(prisma, {
      evenement: "import_csv",
      action: `Depot de ${fichierNom}`,
      resultat: "Fichier vide ou illisible.",
    });
    return {
      fichierNom,
      typeDetecte: "inconnu",
      statut: "echec",
      nbLignes: 0,
      nbNouveaux: 0,
      nbDoublons: 0,
      nbErreurs: 0,
      erreurs: [{ ligne: 0, message: "Fichier vide ou illisible." }],
      importBatchId: batch.id,
    };
  }

  const detection = detectCsvType(normalizedHeaders, headers);

  if (!detection) {
    // Meme logique que pour un document Gmail ambigu (section 7.2) :
    // on n'invente pas le type, on trace le depot pour action manuelle.
    const batch = await prisma.importBatch.create({
      data: {
        fichierNom,
        typeDetecte: "inconnu",
        hashFichier,
        statut: "type_inconnu",
        nbLignes: rows.length,
        details: JSON.stringify({ headers }),
      },
    });
    await logEvenement(prisma, {
      evenement: "import_csv",
      action: `Depot de ${fichierNom}`,
      resultat:
        "Type de fichier non reconnu. Colonnes disponibles : " +
        headers.join(", ") +
        ". Ajuster src/config/mappings/*.json ou verifier le fichier.",
    });
    return {
      fichierNom,
      typeDetecte: "inconnu",
      statut: "type_inconnu",
      nbLignes: rows.length,
      nbNouveaux: 0,
      nbDoublons: 0,
      nbErreurs: 0,
      erreurs: [],
      importBatchId: batch.id,
    };
  }

  // On cree d'abord le lot d'import pour pouvoir y rattacher chaque
  // enregistrement normalise via sourceImportId.
  const batch = await prisma.importBatch.create({
    data: {
      fichierNom,
      typeDetecte: detection.mapping.type,
      hashFichier,
      nbLignes: rows.length,
      statut: "ok",
    },
  });

  const normalizer = NORMALIZERS[detection.mapping.type];
  const { nbNouveaux, nbDoublons, erreurs } = await normalizer(
    prisma,
    rows,
    detection.resolvedColumns,
    batch.id
  );

  const statut: ImportSummary["statut"] = erreurs.length === 0 ? "ok" : nbNouveaux + nbDoublons > 0 ? "partiel" : "echec";

  await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      nbNouveaux,
      nbDoublons,
      nbErreurs: erreurs.length,
      statut,
      details: erreurs.length > 0 ? JSON.stringify(erreurs) : null,
    },
  });

  await logEvenement(prisma, {
    evenement: "import_csv",
    action: `Depot de ${fichierNom} (${detection.mapping.label})`,
    resultat: `${nbNouveaux} nouveau(x), ${nbDoublons} doublon(s), ${erreurs.length} erreur(s).`,
  });

  return {
    fichierNom,
    typeDetecte: detection.mapping.type,
    statut,
    nbLignes: rows.length,
    nbNouveaux,
    nbDoublons,
    nbErreurs: erreurs.length,
    erreurs,
    importBatchId: batch.id,
  };
}
