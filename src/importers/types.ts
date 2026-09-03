export interface MappingConfig {
  type: string;
  label: string;
  requiredFields: string[];
  fields: Record<string, string[]>;
}

export interface DetectionResult {
  mapping: MappingConfig;
  /** Correspondance champ logique -> intitule de colonne d'origine trouve */
  resolvedColumns: Record<string, string>;
  /** Proportion de requiredFields effectivement trouves (0 a 1) */
  score: number;
}

export interface ImportRowError {
  ligne: number;
  message: string;
}

export interface ImportSummary {
  fichierNom: string;
  typeDetecte: string;
  statut: "ok" | "partiel" | "echec" | "type_inconnu" | "doublon_fichier";
  nbLignes: number;
  nbNouveaux: number;
  nbDoublons: number;
  nbErreurs: number;
  erreurs: ImportRowError[];
  importBatchId?: string;
}
