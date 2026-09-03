import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface PdfTransaction {
  date: string; // JJ/MM/AAAA, format directement compatible avec parseFlexibleDate
  libelle: string;
  montant: string; // texte tel qu'imprime sur le releve, ex. "- 149,07", compatible avec parseAmount
}

/**
 * Extrait le texte d'un PDF via l'utilitaire externe `pdftotext` (paquet
 * poppler-utils). Ce binaire doit etre installe sur le serveur : sur
 * OVHcloud Ubuntu (section 16 du cahier des charges), `apt install
 * poppler-utils`.
 */
export function extractPdfText(buffer: Buffer): string {
  const tmpPath = path.join(os.tmpdir(), `releve-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.pdf`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    return execFileSync("pdftotext", ["-layout", tmpPath, "-"], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    const message = (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "L'utilitaire 'pdftotext' (paquet poppler-utils) est introuvable sur ce serveur. Installer poppler-utils pour lire les relevés bancaires PDF."
      : `Echec de lecture du PDF : ${(err as Error).message}`;
    throw new Error(message);
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

// Delimite la section "ledger" chronologique du relevé (celle qui doit
// etre importee) des annexes "DETAIL DE VOS MOUVEMENTS SEPA" /
// "VIREMENTS SEPA RECUS" en fin de document, qui ne font que detailler
// des operations DEJA comptees dans le ledger — les importer aussi
// doublonnerait chaque virement/prelevement SEPA.
const LEDGER_START = /DETAIL DES OPERATIONS DE VOTRE COMPTE COURANT/i;
const LEDGER_END = /DETAIL DE VOS MOUVEMENTS SEPA/i;

// Une ligne d'operation imprime : date comptable, libelle (+ reference
// optionnelle), date operation, date valeur, montant. Les annexes SEPA
// n'ont qu'une seule date par ligne et ne peuvent donc jamais matcher ce
// motif a 3 dates.
const TRANSACTION_LINE =
  /^\s*(\d{2}\/\d{2})\s+(.+?)\s+(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+(-?\s?[\d][\d\s]*,\d{2})\s*€\s*$/;
const REFERENCE_TOKEN = /^[A-Z0-9]{5,10}$/i;

/**
 * Reconstitue les operations d'un relevé de compte Banque Populaire a
 * partir du texte extrait (mise en page conservee, `pdftotext -layout`).
 * Retourne des lignes deja au format texte attendu par les fonctions
 * generiques `parseAmount` / `parseFlexibleDate`, pour reutiliser tel
 * quel le normalisateur `importBankStatement` (voir bankStatement.ts).
 */
export function extractReleveTransactions(pdfText: string): PdfTransaction[] {
  const startIdx = pdfText.search(LEDGER_START);
  const searchBase = startIdx >= 0 ? startIdx : 0;
  const endOffset = pdfText.slice(searchBase).search(LEDGER_END);
  const ledgerText =
    startIdx === -1 ? pdfText : pdfText.slice(startIdx, endOffset === -1 ? undefined : searchBase + endOffset);

  // Annee de reference : entete "... au JJ/MM/AAAA" du relevé.
  const headerMatch = pdfText.match(/au\s+(\d{2})\/(\d{2})\/(\d{4})/);
  const headerMonth = headerMatch ? Number(headerMatch[2]) : null;
  const headerYear = headerMatch ? Number(headerMatch[3]) : new Date().getFullYear();

  const transactions: PdfTransaction[] = [];

  for (const line of ledgerText.split("\n")) {
    const m = line.match(TRANSACTION_LINE);
    if (!m) continue;

    const [, dateCompta, rest, , , montantBrut] = m;

    // Le libelle et la reference (quand elle existe) sont separes par un
    // grand blanc du a la mise en page en colonnes fixes ; les mots d'un
    // meme libelle ne sont eux separes que par un espace simple.
    const chunks = rest.split(/\s{2,}/).filter((c) => c.trim() !== "");
    let libelle: string;
    if (chunks.length >= 2 && REFERENCE_TOKEN.test(chunks[chunks.length - 1].trim())) {
      libelle = chunks.slice(0, -1).join(" ");
    } else {
      libelle = chunks.join(" ");
    }
    libelle = libelle.replace(/\s+/g, " ").trim();
    if (!libelle) continue;

    const mois = Number(dateCompta.split("/")[1]);
    let annee = headerYear;
    if (headerMonth !== null && mois > headerMonth + 1) {
      // Ex. relevé "au" janvier avec une ligne datee decembre : annee precedente.
      annee -= 1;
    }

    transactions.push({
      date: `${dateCompta}/${annee}`,
      libelle,
      montant: montantBrut.replace(/\s+/g, " ").trim(),
    });
  }

  return transactions;
}
