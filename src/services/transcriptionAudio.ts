/**
 * Transcription d'un message vocal en texte (section "devis vocal sur
 * chantier", demande explicite de l'utilisateur : pouvoir dicter un devis a
 * Morgane sans avoir le temps de taper). L'API Claude n'a aucun bloc de
 * contenu audio (seulement texte, image, document PDF) : un service de
 * transcription dedie est necessaire en amont. OpenAI Whisper choisi par
 * l'utilisateur (bon en francais, fonctionne sur iPhone).
 *
 * Jamais de cle API committee : OPENAI_API_KEY (voir .env.example). Absente,
 * la fonctionnalite reste desactivee (meme principe que les autres
 * integrations optionnelles de ce depot - Stripe, Synec, Twilio...).
 */

const ENDPOINT_TRANSCRIPTION = "https://api.openai.com/v1/audio/transcriptions";
const MODELE_TRANSCRIPTION = "whisper-1";

export class TranscriptionAudioError extends Error {}

export async function transcrireAudio(donnees: Buffer, mimeType: string, nomFichier: string): Promise<string> {
  const cleApi = process.env.OPENAI_API_KEY;
  if (!cleApi) {
    throw new TranscriptionAudioError("Transcription audio non configuree (OPENAI_API_KEY absente).");
  }

  const formulaire = new FormData();
  formulaire.append("file", new Blob([donnees], { type: mimeType }), nomFichier);
  formulaire.append("model", MODELE_TRANSCRIPTION);
  // Indice de langue (pas une contrainte stricte chez Whisper) : ameliore la
  // fiabilite pour le vocabulaire metier du batiment, jamais invente/devine
  // a partir d'autre chose que ce choix explicite de l'utilisateur.
  formulaire.append("language", "fr");

  let reponse: Response;
  try {
    reponse = await fetch(ENDPOINT_TRANSCRIPTION, {
      method: "POST",
      headers: { Authorization: `Bearer ${cleApi}` },
      body: formulaire,
    });
  } catch (err) {
    throw new TranscriptionAudioError(`Impossible de joindre le service de transcription : ${(err as Error).message}`);
  }

  if (!reponse.ok) {
    const texteErreur = await reponse.text().catch(() => "");
    throw new TranscriptionAudioError(`Echec de la transcription (${reponse.status}) : ${texteErreur.slice(0, 300)}`);
  }

  const data = (await reponse.json()) as { text?: string };
  const texte = (data.text || "").trim();
  if (!texte) {
    throw new TranscriptionAudioError("Transcription vide : aucun texte reconnu dans l'enregistrement.");
  }
  return texte;
}
