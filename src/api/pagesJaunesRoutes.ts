import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  creerPropositionActualitePagesJaunes,
  listerPropositionsActualitesPagesJaunes,
  accepterPropositionActualitePagesJaunes,
  refuserPropositionActualitePagesJaunes,
  marquerPublieePropositionActualitePagesJaunes,
} from "../services/pagesJaunesActions";

/**
 * Routes du module PagesJaunes/Solocal (mode assiste, voir
 * pagesJaunesActions.ts). L'upload de photo reutilise la route existante
 * /api/reseaux-sociaux/media (meme stockage public/media-publics/), pas de
 * duplication ici.
 */
export function buildPagesJaunesRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/propositions", async (req, res) => {
    const statut = typeof req.query.statut === "string" ? req.query.statut : undefined;
    res.json(await listerPropositionsActualitesPagesJaunes(prisma, statut));
  });

  router.post("/propositions", async (req, res) => {
    try {
      res.json(
        await creerPropositionActualitePagesJaunes(prisma, {
          etablissement: typeof req.body?.etablissement === "string" ? req.body.etablissement : "",
          texte: typeof req.body?.texte === "string" ? req.body.texte : "",
          cheminMedia: typeof req.body?.cheminMedia === "string" ? req.body.cheminMedia : undefined,
          justification: typeof req.body?.justification === "string" ? req.body.justification : "Proposition déposée depuis l'onglet PagesJaunes.",
        })
      );
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.post("/propositions/:id/accepter", async (req, res) => {
    try {
      res.json(await accepterPropositionActualitePagesJaunes(prisma, req.params.id));
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.post("/propositions/:id/refuser", async (req, res) => {
    try {
      res.json(await refuserPropositionActualitePagesJaunes(prisma, req.params.id));
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.post("/propositions/:id/marquer-publiee", async (req, res) => {
    try {
      res.json(await marquerPublieePropositionActualitePagesJaunes(prisma, req.params.id));
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  return router;
}
