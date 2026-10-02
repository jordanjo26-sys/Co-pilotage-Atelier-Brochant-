import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Stockage de la plaquette commerciale jointe aux campagnes d'envoi
 * (section 2.4). Hors du depot git (uploads/, voir .gitignore) : seuls le
 * chemin et le nom d'origine sont persistes en base (EmailTemplate).
 */

const DOSSIER_PIECES_JOINTES = path.join(process.cwd(), "uploads", "prospection");

const TYPES_AUTORISES = new Set(["application/pdf", "image/png", "image/jpeg"]);

export function typeAutorise(mimeType: string): boolean {
  return TYPES_AUTORISES.has(mimeType);
}

export async function enregistrerPieceJointe(
  nomOriginal: string,
  mimeType: string,
  buffer: Buffer
): Promise<{ chemin: string; nom: string; type: string }> {
  await fs.mkdir(DOSSIER_PIECES_JOINTES, { recursive: true });
  const extension = path.extname(nomOriginal) || "";
  const chemin = path.join(DOSSIER_PIECES_JOINTES, `${crypto.randomUUID()}${extension}`);
  await fs.writeFile(chemin, buffer);
  return { chemin, nom: nomOriginal, type: mimeType };
}

/** Supprime l'ancien fichier si present ; jamais bloquant (fichier deja absent, permissions...). */
export async function supprimerPieceJointe(chemin: string | null | undefined): Promise<void> {
  if (!chemin) return;
  await fs.unlink(chemin).catch(() => undefined);
}
