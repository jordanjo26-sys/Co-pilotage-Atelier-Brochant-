import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { buildConsentUrl, handleOAuthCallback } from "../services/googleAuth";
import { logEvenement } from "../services/journalService";

/**
 * Routes du parcours de connexion OAuth Gmail (section 7 et 17 du cahier
 * des charges). Volontairement hors du prefixe /api : ce sont des pages de
 * redirection navigateur, pas des appels programmatiques.
 */
export function buildAuthRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/google", (_req, res) => {
    try {
      res.redirect(buildConsentUrl());
    } catch (err) {
      res.status(500).send(`<p>${(err as Error).message}</p>`);
    }
  });

  router.get("/google/callback", async (req, res) => {
    const code = req.query.code;
    if (typeof code !== "string") {
      return res.status(400).send("<p>Code d'autorisation manquant.</p>");
    }

    try {
      const compteEmail = await handleOAuthCallback(prisma, code);
      await logEvenement(prisma, {
        evenement: "gmail_connexion",
        action: `Connexion Gmail etablie pour ${compteEmail}`,
        resultat: "OAuth reussi, jeton chiffre et enregistre.",
      });
      res.send(
        `<p>Boite Gmail <strong>${compteEmail}</strong> connectee avec succes. ` +
          `Vous pouvez fermer cette page et retourner sur le cockpit.</p>`
      );
    } catch (err) {
      res.status(500).send(`<p>Echec de connexion Gmail : ${(err as Error).message}</p>`);
    }
  });

  return router;
}
