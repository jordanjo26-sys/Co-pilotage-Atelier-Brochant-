import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Diaporama video a partir de vraies photos deja uploadees (demande
 * explicite de l'utilisateur, apres avoir ecarte la video generee par IA -
 * trop couteuse et pas honnete, meme principe que pour les photos). Aucun
 * fournisseur tiers ici : ffmpeg (deja present sur le serveur de production,
 * ajoute a bootstrap.sh) assemble simplement les photos fournies en une
 * courte video, sans aucune IA generative.
 */

const execFileAsync = promisify(execFile);
const DOSSIER_MEDIA_PUBLICS = path.join(process.cwd(), "public", "media-publics");
const MAX_PHOTOS = 10;
const DUREE_PAR_PHOTO_MIN = 1;
const DUREE_PAR_PHOTO_MAX = 10;

export class GenerationVideoPagesJaunesError extends Error {}

function resoudreCheminMediaPublic(cheminRelatif: string): string {
  if (!cheminRelatif.startsWith("media-publics/") || cheminRelatif.includes("..")) {
    throw new GenerationVideoPagesJaunesError(`Chemin invalide : "${cheminRelatif}" (doit etre sous media-publics/, deja uploade).`);
  }
  return path.join(process.cwd(), "public", cheminRelatif);
}

export async function genererVideoDiaporamaPagesJaunes(cheminsImages: string[], dureeParPhotoSecondes = 3): Promise<{ chemin: string }> {
  if (cheminsImages.length === 0) {
    throw new GenerationVideoPagesJaunesError("Au moins une photo est requise.");
  }
  if (cheminsImages.length > MAX_PHOTOS) {
    throw new GenerationVideoPagesJaunesError(`${MAX_PHOTOS} photos maximum par video.`);
  }
  const duree = Math.min(DUREE_PAR_PHOTO_MAX, Math.max(DUREE_PAR_PHOTO_MIN, dureeParPhotoSecondes));

  const cheminsAbsolus: string[] = [];
  for (const chemin of cheminsImages) {
    const absolu = resoudreCheminMediaPublic(chemin);
    try {
      await fs.access(absolu);
    } catch {
      throw new GenerationVideoPagesJaunesError(`Photo introuvable : "${chemin}" (doit deja avoir ete uploadee).`);
    }
    cheminsAbsolus.push(absolu);
  }

  const dossierTemp = await fs.mkdtemp(path.join(os.tmpdir(), "pj-video-"));
  try {
    const cheminsClips: string[] = [];
    for (let i = 0; i < cheminsAbsolus.length; i++) {
      const cheminClip = path.join(dossierTemp, `clip-${i}.mp4`);
      try {
        await execFileAsync("ffmpeg", [
          "-y",
          "-loop", "1",
          "-i", cheminsAbsolus[i],
          "-t", String(duree),
          "-vf", "scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,setsar=1",
          "-r", "25",
          "-c:v", "libx264",
          "-pix_fmt", "yuv420p",
          cheminClip,
        ]);
      } catch (err) {
        throw new GenerationVideoPagesJaunesError(`Echec de traitement de la photo ${i + 1}/${cheminsAbsolus.length} : ${(err as Error).message.slice(0, 300)}`);
      }
      cheminsClips.push(cheminClip);
    }

    const fichierListe = path.join(dossierTemp, "liste.txt");
    await fs.writeFile(fichierListe, cheminsClips.map((c) => `file '${c}'`).join("\n"));

    const cheminSortie = path.join(dossierTemp, "sortie.mp4");
    try {
      await execFileAsync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", fichierListe, "-c", "copy", cheminSortie]);
    } catch (err) {
      throw new GenerationVideoPagesJaunesError(`Echec de l'assemblage final de la video : ${(err as Error).message.slice(0, 300)}`);
    }

    await fs.mkdir(DOSSIER_MEDIA_PUBLICS, { recursive: true });
    const nomFichier = `${crypto.randomUUID()}.mp4`;
    const cheminFinal = path.join(DOSSIER_MEDIA_PUBLICS, nomFichier);
    await fs.copyFile(cheminSortie, cheminFinal);
    return { chemin: `media-publics/${nomFichier}` };
  } finally {
    await fs.rm(dossierTemp, { recursive: true, force: true }).catch(() => {});
  }
}
