import express, { NextFunction, Request, Response, Router } from "express";
import { PrismaClient } from "@prisma/client";
import { direEtEcouter, direEtRaccrocher, messagerie, signatureTwilioValide } from "../services/twilio";
import { demarrerAppel, finaliserAppel, MAX_ERREURS_AVANT_MESSAGERIE, traiterTour } from "../services/standardTelephonique";
import { logEvenement } from "../services/journalService";

/**
 * Webhooks Twilio du standard telephonique IA (voir
 * docs/standard-telephonique.md). Hors du prefixe /api et exclus de la
 * protection par mot de passe nginx (Twilio ne peut pas la saisir) : chaque
 * requete est donc authentifiee par sa signature Twilio, sans quoi
 * n'importe qui pourrait declencher des appels a l'IA ou des e-mails.
 */

const MESSAGE_ERREUR = "Pardon, je n'ai pas bien saisi. Pouvez-vous repeter ?";
const MESSAGE_MESSAGERIE =
  "Je rencontre un probleme technique. Laissez votre nom, votre numero et votre message apres le bip, nous vous rappellerons rapidement.";

function urlPublique(req: Request): string {
  const base = (process.env.TELEPHONE_URL_PUBLIQUE || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  return base + req.originalUrl;
}

function verifierSignatureTwilio(req: Request, res: Response, next: NextFunction) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    res.status(503).send("Standard telephonique non configure (TWILIO_AUTH_TOKEN manquant).");
    return;
  }
  const params = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, String(v)]));
  if (!signatureTwilioValide(authToken, urlPublique(req), params, req.get("X-Twilio-Signature"))) {
    res.status(403).send("Signature Twilio invalide.");
    return;
  }
  next();
}

function envoyerTwiml(res: Response, contenu: string) {
  res.type("text/xml").send(contenu);
}

export function buildTelephonieRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));
  router.use(verifierSignatureTwilio);

  const urlTour = (req: Request) => `${req.baseUrl}/tour`;
  const urlMessagerie = (req: Request) => `${req.baseUrl}/messagerie`;

  // Appel entrant (URL "A call comes in" du numero Twilio).
  router.post("/entrant", async (req, res) => {
    const callSid = String(req.body.CallSid ?? "");
    try {
      // Sans cle API, inutile de faire parler l'appelant pour rien : messagerie directe.
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY manquante");
      const appel = await demarrerAppel(prisma, callSid, req.body.From ? String(req.body.From) : null);
      const transcription = appel.transcription as unknown as { texte: string }[];
      envoyerTwiml(res, direEtEcouter(transcription[0]?.texte ?? "Bonjour, que puis-je faire pour vous ?", urlTour(req)));
    } catch (err) {
      console.error("Standard telephonique - appel entrant :", (err as Error).message);
      envoyerTwiml(res, messagerie(MESSAGE_MESSAGERIE, urlMessagerie(req)));
    }
  });

  // Chaque prise de parole de l'appelant (action du <Gather>).
  router.post("/tour", async (req, res) => {
    const callSid = String(req.body.CallSid ?? "");
    const propos = String(req.body.SpeechResult ?? "").trim();
    const appel = await prisma.appel.findUnique({ where: { callSid } });
    if (!appel) {
      envoyerTwiml(res, messagerie(MESSAGE_MESSAGERIE, urlMessagerie(req)));
      return;
    }

    if (!propos) {
      const silences = appel.silences + 1;
      await prisma.appel.update({ where: { id: appel.id }, data: { silences } });
      if (silences >= 2) {
        envoyerTwiml(res, direEtRaccrocher("Je ne vous entends plus. N'hesitez pas a rappeler. Au revoir."));
        finaliserAppel(prisma, callSid).catch(() => {});
      } else {
        envoyerTwiml(res, direEtEcouter("Vous etes toujours la ?", urlTour(req)));
      }
      return;
    }

    try {
      const { reponse, raccrocher } = await traiterTour(prisma, appel, propos);
      if (raccrocher) {
        envoyerTwiml(res, direEtRaccrocher(reponse));
        finaliserAppel(prisma, callSid).catch(() => {});
      } else {
        envoyerTwiml(res, direEtEcouter(reponse, urlTour(req)));
      }
    } catch (err) {
      console.error("Standard telephonique - tour :", (err as Error).message);
      await logEvenement(prisma, {
        evenement: "appel_erreur_ia",
        action: `Appel ${callSid}`,
        resultat: (err as Error).message,
      }).catch(() => {});
      envoyerTwiml(
        res,
        appel.erreurs + 1 >= MAX_ERREURS_AVANT_MESSAGERIE
          ? messagerie(MESSAGE_MESSAGERIE, urlMessagerie(req))
          : direEtEcouter(MESSAGE_ERREUR, urlTour(req))
      );
    }
  });

  // Fin de la messagerie de secours (action du <Record>).
  router.post("/messagerie", async (req, res) => {
    const callSid = String(req.body.CallSid ?? "");
    const url = req.body.RecordingUrl ? `${String(req.body.RecordingUrl)}.mp3` : null;
    // notifieLe remis a zero : si la fin d'appel a deja ete signalee (appelant
    // qui raccroche pendant l'enregistrement), le compte rendu repart avec
    // le lien du message vocal plutot que de le perdre.
    await prisma.appel.upsert({
      where: { callSid },
      update: { enregistrementUrl: url, notifieLe: null },
      create: { callSid, numeroAppelant: req.body.From ? String(req.body.From) : null, enregistrementUrl: url },
    });
    envoyerTwiml(res, direEtRaccrocher("Merci, votre message a bien ete transmis. Au revoir."));
    finaliserAppel(prisma, callSid).catch(() => {});
  });

  // Changement d'etat de l'appel (URL "Call status changes" du numero) :
  // garantit le compte rendu meme si l'appelant raccroche en cours de route.
  router.post("/statut", async (req, res) => {
    const callSid = String(req.body.CallSid ?? "");
    const statut = String(req.body.CallStatus ?? "");
    if (["completed", "busy", "failed", "no-answer", "canceled"].includes(statut)) {
      const existe = await prisma.appel.findUnique({ where: { callSid } });
      if (existe) await finaliserAppel(prisma, callSid).catch(() => {});
    }
    res.sendStatus(204);
  });

  return router;
}
