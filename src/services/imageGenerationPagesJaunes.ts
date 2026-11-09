import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Generation d'une photo illustrative pour une actualite PagesJaunes, quand
 * l'utilisateur n'a pas de vraie photo sous la main (demande explicite,
 * choisie en complement de l'upload de vraies photos deja possible - jamais
 * a la place). L'API Claude ne genere pas d'images : OpenAI (deja utilise
 * pour la transcription audio, meme cle OPENAI_API_KEY) est le fournisseur
 * choisi.
 *
 * Garde-fou important : une image generee par IA ne represente PAS un vrai
 * chantier/client - presenter une image fabriquee comme une preuve d'un
 * travail reel serait trompeur pour un artisan. Le prompt doit donc rester
 * generique/illustratif (jamais "ceci est notre client X" ou une scene
 * presentee comme un fait reel) - impose cote appelant (morgane.ts), pas
 * verifiable techniquement ici.
 */

const ENDPOINT_IMAGES = "https://api.openai.com/v1/images/generations";
const MODELE_IMAGE = "gpt-image-1.5";
const DOSSIER_MEDIA_PUBLICS = path.join(process.cwd(), "public", "media-publics");

export class GenerationImagePagesJaunesError extends Error {}

export async function genererImagePagesJaunes(description: string): Promise<{ chemin: string }> {
  const cleApi = process.env.OPENAI_API_KEY;
  if (!cleApi) {
    throw new GenerationImagePagesJaunesError("Generation d'image non configuree (OPENAI_API_KEY absente).");
  }
  if (!description) {
    throw new GenerationImagePagesJaunesError("description manquante.");
  }

  let reponse: Response;
  try {
    reponse = await fetch(ENDPOINT_IMAGES, {
      method: "POST",
      headers: { Authorization: `Bearer ${cleApi}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODELE_IMAGE, prompt: description, size: "1024x1024", quality: "medium", n: 1 }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new GenerationImagePagesJaunesError(`Impossible de joindre le service de generation d'image : ${(err as Error).message}`);
  }

  if (!reponse.ok) {
    const texteErreur = await reponse.text().catch(() => "");
    throw new GenerationImagePagesJaunesError(`Echec de la generation d'image (${reponse.status}) : ${texteErreur.slice(0, 300)}`);
  }

  const data = (await reponse.json()) as { data?: { b64_json?: string }[] };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) {
    throw new GenerationImagePagesJaunesError("La generation d'image n'a renvoye aucune image.");
  }

  await fs.mkdir(DOSSIER_MEDIA_PUBLICS, { recursive: true });
  const nomFichier = `${crypto.randomUUID()}.png`;
  await fs.writeFile(path.join(DOSSIER_MEDIA_PUBLICS, nomFichier), Buffer.from(b64, "base64"));
  return { chemin: `media-publics/${nomFichier}` };
}
