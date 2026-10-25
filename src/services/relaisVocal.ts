import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";
import { WebSocket, WebSocketServer } from "ws";
import { demarrerAppel, traiterTour } from "./standardTelephonique";
import { signatureTwilioValide } from "./twilio";
import { logEvenement } from "./journalService";

/**
 * Relais vocal temps reel (Twilio ConversationRelay) : Twilio transcrit la
 * parole de l'appelant, l'envoie ici par WebSocket, et prononce le texte
 * renvoye au fur et a mesure de sa generation. Par rapport au mode
 * <Gather>/<Say> (requete HTTP a chaque replique, reponse complete avant de
 * parler), Morgane commence a parler des les premiers mots et l'appelant
 * peut lui couper la parole : conversation nettement plus fluide.
 *
 * L'etat de la conversation reste en base (table Appel) : si la connexion
 * tombe (redemarrage d'une instance pendant un deploiement), Twilio rappelle
 * l'URL d'action du <Connect>, qui relance un relais sur l'autre instance
 * et la conversation reprend la ou elle en etait (voir telephonieRoutes).
 */

export const CHEMIN_RELAIS = "/telephonie/relais";

interface MessageTwilio {
  type: string;
  callSid?: string;
  from?: string;
  voicePrompt?: string;
  last?: boolean;
  description?: string;
}

/** URL publique HTTPS / WSS du relais (pour la signature et le TwiML). */
export function urlRelais(base: string): string {
  return `${base.replace(/^http/, "ws").replace(/\/$/, "")}${CHEMIN_RELAIS}`;
}

/**
 * Twilio signe la requete d'ouverture de la WebSocket (X-Twilio-Signature,
 * sans parametres). La documentation ne precise pas si l'URL signee est en
 * wss:// ou https:// : les deux sont acceptees.
 */
export function signatureRelaisValide(authToken: string, base: string, req: IncomingMessage): boolean {
  const signature = req.headers["x-twilio-signature"];
  if (typeof signature !== "string") return false;
  const chemin = req.url ?? CHEMIN_RELAIS;
  const racine = base.replace(/\/$/, "");
  const candidates = [`${racine}${chemin}`, `${racine.replace(/^http/, "ws")}${chemin}`];
  return candidates.some((url) => signatureTwilioValide(authToken, url, {}, signature));
}

export function installerRelaisVocal(
  server: Server,
  prisma: PrismaClient,
  fabriqueClient: () => Anthropic = () => new Anthropic({ maxRetries: 0 })
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url?.startsWith(CHEMIN_RELAIS)) {
      socket.destroy();
      return;
    }
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const base = process.env.TELEPHONE_URL_PUBLIQUE || `https://${req.headers.host}`;
    if (!authToken || !signatureRelaisValide(authToken, base, req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => gererSession(ws, prisma, fabriqueClient()));
  });

  return wss;
}

function envoyer(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function gererSession(ws: WebSocket, prisma: PrismaClient, client: Anthropic): void {
  let callSid = "";
  let numeroAppelant: string | null = null;
  // Les repliques sont traitees l'une apres l'autre (jamais deux generations
  // en parallele sur la meme conversation).
  let file: Promise<void> = Promise.resolve();
  // Numero de la generation en cours : une interruption de l'appelant fait
  // ignorer la suite de la reponse en cours (Twilio a deja coupe la parole).
  let generation = 0;
  let interrompue = -1;

  const traiter = async (propos: string) => {
    const numero = ++generation;
    const appel =
      (await prisma.appel.findUnique({ where: { callSid } })) ?? (await demarrerAppel(prisma, callSid, numeroAppelant));
    try {
      const resultat = await traiterTour(prisma, appel, propos, client, {
        onTexte: (morceau) => {
          if (interrompue !== numero && morceau) envoyer(ws, { type: "text", token: morceau, last: false });
        },
      });
      if (resultat.raccrocher) {
        // Phrase d'au revoir prononcee par le TwiML de fin (route
        // /telephonie/fin-relais), apres la fermeture propre du relais.
        envoyer(ws, { type: "text", token: "", last: true });
        envoyer(ws, { type: "end", handoffData: JSON.stringify({ raison: "fin", messageFinal: resultat.messageFinal ?? "" }) });
        return;
      }
      envoyer(ws, { type: "text", token: "", last: true });
    } catch (err) {
      console.error("Relais vocal - replique :", (err as Error).message);
      await logEvenement(prisma, { evenement: "appel_erreur_ia", action: `Appel ${callSid} (relais)`, resultat: (err as Error).message }).catch(() => {});
      envoyer(ws, { type: "text", token: "Pardon, je n'ai pas bien saisi. Pouvez-vous repeter ?", last: true });
    }
  };

  ws.on("message", (donnees) => {
    let message: MessageTwilio;
    try {
      message = JSON.parse(donnees.toString()) as MessageTwilio;
    } catch {
      return;
    }
    switch (message.type) {
      case "setup":
        callSid = message.callSid ?? "";
        numeroAppelant = message.from ?? null;
        break;
      case "prompt":
        if (message.last === false || !message.voicePrompt?.trim() || !callSid) break;
        file = file.then(() => traiter(message.voicePrompt!.trim()));
        break;
      case "interrupt":
        interrompue = generation;
        break;
      case "error":
        console.error("Relais vocal - erreur Twilio :", message.description);
        break;
    }
  });
}
