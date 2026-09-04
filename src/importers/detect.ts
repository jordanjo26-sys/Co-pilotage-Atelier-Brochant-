import fs from "node:fs";
import path from "node:path";
import { normalizeHeader } from "./csvUtils";
import { DetectionResult, MappingConfig } from "./types";

// process.cwd() plutot que __dirname : ces JSON ne sont pas des modules
// importes (tsc ne les copie donc pas dans dist/), il faut les lire depuis
// leur emplacement source reel (src/config/mappings), present a la fois en
// developpement (tsx, cwd = racine du projet) et en production (rsync
// synchronise src/, WorkingDirectory du service systemd = racine du projet).
const MAPPINGS_DIR = path.join(process.cwd(), "src", "config", "mappings");

let cachedMappings: MappingConfig[] | null = null;

/**
 * Charge toutes les configurations de mapping (fichiers JSON dans
 * src/config/mappings). C'est ce dossier qu'il faut ajuster lorsque les
 * vrais exports Synec / Stripe / banque different des intitules par defaut.
 */
export function loadMappings(): MappingConfig[] {
  if (cachedMappings) return cachedMappings;
  const files = fs.readdirSync(MAPPINGS_DIR).filter((f) => f.endsWith(".json"));
  cachedMappings = files.map((f) => {
    const raw = fs.readFileSync(path.join(MAPPINGS_DIR, f), "utf8");
    return JSON.parse(raw) as MappingConfig;
  });
  return cachedMappings;
}

/**
 * Compare les en-tetes normalises d'un CSV a une configuration de mapping et
 * retourne les colonnes resolues ainsi qu'un score de correspondance.
 */
function matchMapping(
  normalizedHeaders: string[],
  originalHeaders: string[],
  mapping: MappingConfig
): DetectionResult {
  const resolvedColumns: Record<string, string> = {};

  for (const [field, aliases] of Object.entries(mapping.fields)) {
    const normalizedAliases = aliases.map(normalizeHeader);
    const idx = normalizedHeaders.findIndex((h) => normalizedAliases.includes(h));
    if (idx !== -1) {
      resolvedColumns[field] = originalHeaders[idx];
    }
  }

  const foundRequired = mapping.requiredFields.filter((f) => resolvedColumns[f] !== undefined);
  const score = mapping.requiredFields.length === 0 ? 0 : foundRequired.length / mapping.requiredFields.length;

  return { mapping, resolvedColumns, score };
}

const DETECTION_THRESHOLD = 1; // tous les champs requis doivent etre trouves

/**
 * Determine quel type de CSV correspond le mieux aux en-tetes fournis.
 * Retourne null si aucun mapping n'atteint le seuil minimal : dans ce cas
 * le fichier doit etre traite comme "type_inconnu" (cf. section 8, principe
 * du centre de validation applique ici a la classification des imports).
 */
export function detectCsvType(
  normalizedHeaders: string[],
  originalHeaders: string[]
): DetectionResult | null {
  const mappings = loadMappings();
  const results = mappings
    .map((m) => matchMapping(normalizedHeaders, originalHeaders, m))
    .sort((a, b) => b.score - a.score);

  const best = results[0];
  if (!best || best.score < DETECTION_THRESHOLD) return null;
  return best;
}
