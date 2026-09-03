import { parse } from "csv-parse/sync";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";

dayjs.extend(customParseFormat);

/**
 * Normalise un intitule de colonne pour comparaison insensible a la casse,
 * aux accents et a la ponctuation : "N° Facture" -> "n facture".
 */
export function normalizeHeader(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // retire les accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Devine le separateur (";" ou ",") le plus probable a partir de la ligne
 * d'en-tete. Les exports francais (Synec, banques) utilisent souvent ";",
 * les exports Stripe utilisent ",".
 */
export function detectDelimiter(headerLine: string): string {
  const semicolons = (headerLine.match(/;/g) || []).length;
  const commas = (headerLine.match(/,/g) || []).length;
  return semicolons > commas ? ";" : ",";
}

export interface ParsedCsv {
  headers: string[];
  normalizedHeaders: string[];
  rows: Record<string, string>[];
  delimiter: string;
}

/**
 * Lit un CSV (en gerant le BOM UTF-8) et retourne les lignes sous forme
 * d'objets indexes par intitule de colonne d'origine.
 */
export function parseCsvBuffer(buffer: Buffer): ParsedCsv {
  let content = buffer.toString("utf8");
  // Retire un eventuel BOM (frequent dans les exports Excel/Windows)
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  const firstLine = content.split(/\r?\n/, 1)[0] || "";
  const delimiter = detectDelimiter(firstLine);

  const records: string[][] = parse(content, {
    delimiter,
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (records.length === 0) {
    return { headers: [], normalizedHeaders: [], rows: [], delimiter };
  }

  const headers = records[0];
  const normalizedHeaders = headers.map(normalizeHeader);

  const rows = records.slice(1).map((record) => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = record[i] ?? "";
    });
    return row;
  });

  return { headers, normalizedHeaders, rows, delimiter };
}

/**
 * Convertit un montant textuel en nombre, en geant les deux conventions
 * courantes : "1 234,56 €" (format francais) et "1,234.56" (format anglo-saxon).
 * Retourne null si la valeur est vide ou illisible.
 */
export function parseAmount(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  let s = raw.trim();
  if (s === "") return null;

  // Retire les symboles monetaires et espaces (dont les espaces insecables)
  s = s.replace(/[€$£\s ]/g, "");

  const negative = /^-/.test(s) || /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, "");

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    // Le dernier separateur rencontre est le separateur decimal.
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) {
      // format francais : "1.234,56"
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // format anglo-saxon : "1,234.56"
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    // Une seule virgule : c'est un separateur decimal francais.
    s = s.replace(",", ".");
  }

  const value = Number(s);
  if (Number.isNaN(value)) return null;
  return negative ? -Math.abs(value) : value;
}

const DATE_FORMATS = [
  "DD/MM/YYYY",
  "DD/MM/YY",
  "YYYY-MM-DD",
  "YYYY-MM-DD HH:mm:ss",
  "DD-MM-YYYY",
  "MM/DD/YYYY",
  "MMM D, YYYY",
  "D MMM YYYY",
];

/**
 * Convertit une date textuelle en Date JS en essayant plusieurs formats
 * courants (francais, ISO, exports Stripe). Retourne null si illisible.
 */
export function parseFlexibleDate(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s === "") return null;

  // Timestamp Unix (parfois utilise dans les exports Stripe bruts)
  if (/^\d{10}$/.test(s)) {
    return dayjs.unix(Number(s)).toDate();
  }

  for (const format of DATE_FORMATS) {
    const d = dayjs(s, format, true);
    if (d.isValid()) return d.toDate();
  }

  // Dernier recours : parseur natif (gere les ISO 8601 avec heure/fuseau)
  const fallback = dayjs(s);
  return fallback.isValid() ? fallback.toDate() : null;
}
