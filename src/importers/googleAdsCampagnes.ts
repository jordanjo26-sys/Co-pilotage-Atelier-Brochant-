import { parse } from "csv-parse/sync";
import { normalizeHeader, detectDelimiter, parseAmount } from "./csvUtils";

/**
 * Lecture des exports CSV "Campagnes" de Google Ads (palliatif en attendant
 * l'acces API en production - voir docs/mise-en-service.md et la
 * conversation avec l'utilisateur, compte en "Acces Explorer").
 *
 * Contrairement aux exports Synec/Stripe (receiveCsv, src/importers/*.ts),
 * un export Google Ads n'a PAS l'en-tete sur la premiere ligne : il commence
 * par un titre de rapport et une periode ("Rapport des campagnes",
 * "1 janv. 2026-21 oct. 2026"...), variable selon la langue/configuration
 * du compte, et se termine souvent par une ligne "Total". Ce module
 * recherche donc la vraie ligne d'en-tete plutot que de supposer qu'elle est
 * en premiere position, et ignore la ligne de total finale.
 */

const ALIAS_CHAMPS: Record<string, string[]> = {
  nom: ["campagne"],
  statut: ["etat", "statut"],
  type: ["type de campagne", "type"],
  budgetQuotidien: ["budget"],
  impressions: ["impr", "impressions"],
  clics: ["clics"],
  cout: ["cout"],
  conversions: ["conversions"],
  ctr: ["ctr"],
  cpcMoyen: ["cpc moy", "cpc moyen"],
};

// Une ligne d'en-tete plausible doit au moins nommer la campagne ET une
// metrique numerique : un simple "Campagne" seul seul apparaitrait aussi
// dans le titre du rapport ("Rapport des campagnes").
const CHAMPS_OBLIGATOIRES: (keyof typeof ALIAS_CHAMPS)[] = ["nom", "clics"];

export interface LigneCampagneAds {
  nom: string;
  statut: string | null;
  type: string | null;
  budgetQuotidien: number | null;
  impressions: number | null;
  clics: number | null;
  cout: number | null;
  conversions: number | null;
  ctr: number | null;
  cpcMoyen: number | null;
}

function parsePourcentage(raw: string | undefined): number | null {
  if (!raw) return null;
  return parseAmount(raw.replace(/%/g, ""));
}

function parseEntier(raw: string | undefined): number | null {
  const valeur = parseAmount(raw);
  return valeur === null ? null : Math.round(valeur);
}

/**
 * Parcourt les premieres lignes du fichier pour trouver celle qui ressemble
 * a un en-tete de colonnes (ignore titre/periode de rapport). Retourne
 * l'index de cette ligne et le delimiteur detecte, ou null si aucune ligne
 * plausible n'est trouvee dans les 20 premieres lignes.
 */
function trouverLigneEntete(lignes: string[]): { index: number; delimiteur: string } | null {
  const limite = Math.min(lignes.length, 20);
  for (let i = 0; i < limite; i++) {
    const ligne = lignes[i];
    if (!ligne.trim()) continue;
    const delimiteur = detectDelimiter(ligne);
    const cellules = ligne.split(delimiteur).map(normalizeHeader);
    const champsTrouves = CHAMPS_OBLIGATOIRES.every((champ) =>
      ALIAS_CHAMPS[champ].some((alias) => cellules.includes(alias))
    );
    if (champsTrouves) return { index: i, delimiteur };
  }
  return null;
}

export class EnteteGoogleAdsIntrouvable extends Error {}

/**
 * Convertit un export CSV "Campagnes" de Google Ads en lignes normalisees.
 * Leve EnteteGoogleAdsIntrouvable si aucune ligne d'en-tete plausible n'est
 * trouvee (fichier different de ce qui est attendu) : jamais de supposition
 * silencieuse sur la structure du fichier.
 */
export function parserCampagnesAds(buffer: Buffer): LigneCampagneAds[] {
  let contenu = buffer.toString("utf8");
  if (contenu.charCodeAt(0) === 0xfeff) contenu = contenu.slice(1);

  const lignes = contenu.split(/\r?\n/);
  const entete = trouverLigneEntete(lignes);
  if (!entete) {
    throw new EnteteGoogleAdsIntrouvable(
      "Ligne d'en-tete introuvable (colonnes attendues : Campagne, Clics...). Verifier qu'il s'agit bien d'un export 'Campagnes' de Google Ads."
    );
  }

  const contenuUtile = lignes.slice(entete.index).join("\n");
  const records: string[][] = parse(contenuUtile, {
    delimiter: entete.delimiteur,
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });

  const enTetes = records[0].map(normalizeHeader);
  const colonnes: Partial<Record<keyof typeof ALIAS_CHAMPS, number>> = {};
  for (const [champ, alias] of Object.entries(ALIAS_CHAMPS)) {
    const idx = enTetes.findIndex((h) => alias.includes(h));
    if (idx !== -1) colonnes[champ as keyof typeof ALIAS_CHAMPS] = idx;
  }

  const cellule = (ligne: string[], champ: keyof typeof ALIAS_CHAMPS): string | undefined => {
    const idx = colonnes[champ];
    return idx !== undefined ? ligne[idx] : undefined;
  };

  const lignesCampagnes: LigneCampagneAds[] = [];
  for (const ligne of records.slice(1)) {
    const nomBrut = cellule(ligne, "nom")?.trim();
    // Ignore les lignes vides, de total ("Total", "Total : --"...) ou de
    // rupture ("--") : seule une vraie campagne nommee nous interesse.
    if (!nomBrut || /^(total|--)/i.test(nomBrut)) continue;

    lignesCampagnes.push({
      nom: nomBrut,
      statut: cellule(ligne, "statut")?.trim() || null,
      type: cellule(ligne, "type")?.trim() || null,
      budgetQuotidien: parseAmount(cellule(ligne, "budgetQuotidien")),
      impressions: parseEntier(cellule(ligne, "impressions")),
      clics: parseEntier(cellule(ligne, "clics")),
      cout: parseAmount(cellule(ligne, "cout")),
      conversions: parseAmount(cellule(ligne, "conversions")),
      ctr: parsePourcentage(cellule(ligne, "ctr")),
      cpcMoyen: parseAmount(cellule(ligne, "cpcMoyen")),
    });
  }

  return lignesCampagnes;
}
