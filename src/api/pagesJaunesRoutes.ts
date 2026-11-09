import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  creerPropositionActualite,
  creerPropositionInfoFiche,
  creerPropositionReponseAvis,
  listerPropositionsPagesJaunes,
  accepterPropositionPagesJaunes,
  refuserPropositionPagesJaunes,
  marquerPublieePropositionPagesJaunes,
} from "../services/pagesJaunesActions";
import { genererImagePagesJaunes, GenerationImagePagesJaunesError } from "../services/imageGenerationPagesJaunes";

/**
 * Routes du module PagesJaunes/Solocal (mode assiste, voir
 * pagesJaunesActions.ts). L'upload de photo (actualites uniquement)
 * reutilise la route existante /api/reseaux-sociaux/media (meme stockage
 * public/media-publics/), pas de duplication ici.
 */
export function buildPagesJaunesRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/propositions", async (req, res) => {
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const statut = typeof req.query.statut === "string" ? req.query.statut : undefined;
    res.json(await listerPropositionsPagesJaunes(prisma, type, statut));
  });

  router.post("/generer-photo", async (req, res) => {
    try {
      const chemin = await genererImagePagesJaunes(typeof req.body?.description === "string" ? req.body.description : "");
      res.json(chemin);
    } catch (err) {
      if (err instanceof GenerationImagePagesJaunesError) return res.status(400).json({ erreur: err.message });
      res.status(500).json({ erreur: (err as Error).message });
    }
  });

  router.post("/propositions/actualite", async (req, res) => {
    try {
      res.json(
        await creerPropositionActualite(prisma, {
          texte: typeof req.body?.texte === "string" ? req.body.texte : "",
          cheminMedia: typeof req.body?.cheminMedia === "string" ? req.body.cheminMedia : undefined,
          justification: typeof req.body?.justification === "string" ? req.body.justification : "Actualité proposée depuis l'onglet PagesJaunes.",
        })
      );
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.post("/propositions/info-fiche", async (req, res) => {
    try {
      res.json(
        await creerPropositionInfoFiche(prisma, {
          champFiche: typeof req.body?.champFiche === "string" ? req.body.champFiche : "",
          texte: typeof req.body?.texte === "string" ? req.body.texte : "",
          justification: typeof req.body?.justification === "string" ? req.body.justification : "Mise à jour de fiche proposée depuis l'onglet PagesJaunes.",
        })
      );
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.post("/propositions/avis", async (req, res) => {
    try {
      res.json(
        await creerPropositionReponseAvis(prisma, {
          avisTexte: typeof req.body?.avisTexte === "string" ? req.body.avisTexte : "",
          texte: typeof req.body?.texte === "string" ? req.body.texte : "",
          avisClientNom: typeof req.body?.avisClientNom === "string" ? req.body.avisClientNom : undefined,
          avisNote: typeof req.body?.avisNote === "number" ? req.body.avisNote : undefined,
          justification: typeof req.body?.justification === "string" ? req.body.justification : "Réponse à un avis proposée depuis l'onglet PagesJaunes.",
        })
      );
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.post("/propositions/:id/accepter", async (req, res) => {
    try {
      res.json(await accepterPropositionPagesJaunes(prisma, req.params.id));
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.post("/propositions/:id/refuser", async (req, res) => {
    try {
      res.json(await refuserPropositionPagesJaunes(prisma, req.params.id));
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.post("/propositions/:id/marquer-publiee", async (req, res) => {
    try {
      res.json(await marquerPublieePropositionPagesJaunes(prisma, req.params.id));
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  return router;
}
