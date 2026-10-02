/**
 * Determine le Content-Type a servir pour la previsualisation d'un
 * document (section 7, bouton "Voir" des anomalies et des factures
 * fournisseurs). Priorite a l'extension du nom de fichier plutot qu'au
 * mimeType declare par l'expediteur/Gmail : certaines plateformes tierces
 * d'envoi de documents (constate en production avec un expediteur du
 * type "dataflow@...cloud") rapportent un type generique ou incorrect,
 * ce qui forcait un telechargement au lieu d'un affichage quel que soit
 * le mecanisme cote navigateur (aucun navigateur ne sait afficher
 * "application/octet-stream" nativement, contrairement a "application/pdf").
 * L'extension d'un nom de fichier est en pratique un signal bien plus
 * fiable que l'en-tete MIME pour les formats les plus courants.
 */
const MIME_PAR_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  tif: "image/tiff",
  tiff: "image/tiff",
};

export function typeMimePourAffichage(nomFichier: string | null | undefined, mimeTypeDeclare: string | null | undefined): string {
  const extension = (nomFichier || "").split(".").pop()?.toLowerCase();
  if (extension && MIME_PAR_EXTENSION[extension]) return MIME_PAR_EXTENSION[extension];
  return mimeTypeDeclare || "application/octet-stream";
}
