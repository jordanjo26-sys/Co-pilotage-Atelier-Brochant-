import { PrismaClient } from "@prisma/client";
import { parseCsvBuffer } from "../importers/csvUtils";
import { detectCsvType } from "../importers/detect";
import { NORMALIZERS } from "../importers/index";
import { importBankStatement } from "../importers/bankStatement";
import { extractPdfText, extractReleveTransactions } from "../importers/bankStatementPdf";
import { sha256Hex } from "./hash";
import { ImportRowError, ImportSummary } from "../importers/types";
import { logEvenement } from "./journalService";
import { executerRapprochementBancaire } from "./rapprochementBancaire";

// Un nouvel import de payouts ou de releve bancaire peut completer un
// rapprochement en attente (section 5) - inutile pour les autres types
// (factures, clients...) qui ne fournissent ni l'un ni l'autre cote.
const TYPES_DECLENCHANT_RAPPROCHEMENT = new Set(["banque_releve", "banque_releve_pdf", "stripe_payouts"]);

async function tenterRapprochementSiPertinent(prisma: PrismaClient, typeDetecte: string): Promise<void> {
  if (TYPES_DECLENCHANT_RAPPROCHEMENT.has(typeDetecte)) {
    await executerRapprochementBancaire(prisma);
  }
}

function isPdfFile(buffer: Buffer, fichierNom: string): boolean {
  return buffer.subarray(0, 5).toString("latin1") === "%PDF-" || fichierNom.toLowerCase().endsWith(".pdf");
}

/**
 * Termine un import (mise a jour du lot, journal, resume renvoye a
 * l'appelant) une fois les lignes normalisees, quel que soit le format
 * d'origine (CSV ou PDF).
 */
async function finalizeImport(
  prisma: PrismaClient,
  fichierNom: string,
  typeDetecte: string,
  label: string,
  batchId: string,
  nbLignes: number,
  result: { nbNouveaux: number; nbDoublons: number; erreurs: ImportRowError[] }
): Promise<ImportSummary> {
  const { nbNouveaux, nbDoublons, erreurs } = result;
  const statut: ImportSummary["statut"] =
    erreurs.length === 0 ? "ok" : nbNouveaux + nbDoublons > 0 ? "partiel" : "echec";

  await prisma.importBatch.update({
    where: { id: batchId },
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
    action: `Depot de ${fichierNom} (${label})`,
    resultat: `${nbNouveaux} nouveau(x), ${nbDoublons} doublon(s), ${erreurs.length} erreur(s).`,
  });

  return {
    fichierNom,
    typeDetecte,
    statut,
    nbLignes,
    nbNouveaux,
    nbDoublons,
    nbErreurs: erreurs.length,
    erreurs,
    importBatchId: batchId,
  };
}

/**
 * Reception d'un relevé de compte au format PDF (Banque Populaire). Le
 * texte est extrait puis les operations reconnues sont transmises au
 * normalisateur generique `importBankStatement`, comme si elles venaient
 * d'un CSV — voir bankStatementPdf.ts pour le detail de l'extraction.
 */
async function receivePdfBankStatement(
  prisma: PrismaClient,
  fichierNom: string,
  buffer: Buffer,
  hashFichier: string
): Promise<ImportSummary> {
  let transactions;
  try {
    const texte = extractPdfText(buffer);
    transactions = extractReleveTransactions(texte);
  } catch (err) {
    const batch = await prisma.importBatch.create({
      data: {
        fichierNom,
        typeDetecte: "banque_releve_pdf",
        hashFichier,
        statut: "echec",
        nbLignes: 0,
        details: JSON.stringify([{ ligne: 0, message: (err as Error).message }]),
      },
    });
    await logEvenement(prisma, {
      evenement: "import_csv",
      action: `Depot de ${fichierNom}`,
      resultat: `Echec de lecture du PDF : ${(err as Error).message}`,
    });
    return {
      fichierNom,
      typeDetecte: "banque_releve_pdf",
      statut: "echec",
      nbLignes: 0,
      nbNouveaux: 0,
      nbDoublons: 0,
      nbErreurs: 1,
      erreurs: [{ ligne: 0, message: (err as Error).message }],
      importBatchId: batch.id,
    };
  }

  if (transactions.length === 0) {
    // Mise en page non reconnue (PDF different d'un relevé Banque
    // Populaire) : on trace pour verification manuelle, jamais on ne
    // devine.
    const batch = await prisma.importBatch.create({
      data: { fichierNom, typeDetecte: "inconnu", hashFichier, statut: "type_inconnu", nbLignes: 0 },
    });
    await logEvenement(prisma, {
      evenement: "import_csv",
      action: `Depot de ${fichierNom}`,
      resultat: "Aucune operation reconnue dans ce PDF (mise en page non prise en charge).",
    });
    return {
      fichierNom,
      typeDetecte: "inconnu",
      statut: "type_inconnu",
      nbLignes: 0,
      nbNouveaux: 0,
      nbDoublons: 0,
      nbErreurs: 0,
      erreurs: [],
      importBatchId: batch.id,
    };
  }

  const batch = await prisma.importBatch.create({
    data: { fichierNom, typeDetecte: "banque_releve_pdf", hashFichier, nbLignes: transactions.length, statut: "ok" },
  });

  const rows = transactions.map((t) => ({ date: t.date, libelle: t.libelle, montant: t.montant }));
  const resolvedColumns = { date: "date", libelle: "libelle", montant: "montant" };
  const result = await importBankStatement(prisma, rows, resolvedColumns, batch.id);

  const summary = await finalizeImport(
    prisma,
    fichierNom,
    "banque_releve_pdf",
    "Relevé bancaire (PDF)",
    batch.id,
    transactions.length,
    result
  );
  await tenterRapprochementSiPertinent(prisma, "banque_releve_pdf");
  return summary;
}

/**
 * Point d'entree unique de la reception d'un fichier (CSV ou PDF) :
 * detection du type, controle de doublon au niveau du fichier, dispatch
 * vers le bon normalisateur, puis enregistrement du lot d'import et du
 * journal.
 *
 * Reprend le pipeline documentaire de la section 7.2 du cahier des charges,
 * adapte aux fichiers CSV/PDF (au lieu des pieces jointes Gmail) : detecter,
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

  if (isPdfFile(buffer, fichierNom)) {
    return receivePdfBankStatement(prisma, fichierNom, buffer, hashFichier);
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
  const result = await normalizer(prisma, rows, detection.resolvedColumns, batch.id);

  const summary = await finalizeImport(prisma, fichierNom, detection.mapping.type, detection.mapping.label, batch.id, rows.length, result);
  await tenterRapprochementSiPertinent(prisma, detection.mapping.type);
  return summary;
}
