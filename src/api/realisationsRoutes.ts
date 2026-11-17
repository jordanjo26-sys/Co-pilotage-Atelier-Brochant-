import { Router } from "express";
import multer from "multer";
import { PrismaClient } from "@prisma/client";
import {
  listerActivitesRealisations,
  modifierEmailActiviteRealisation,
  ajouterPhotosRealisation,
  listerPhotosRealisation,
  supprimerPhotoRealisation,
  ActiviteRealisationError,
  TYPES_IMAGE_REALISATIONS,
} from "../services/realisations";

/**
 * Routes du module Realisations (galerie photos pour les prestataires
 * externes, voir realisations.ts). La page de galerie publique elle-meme
 * (/galerie-realisations/:token) est montee directement dans server.ts
 * (hors prefixe /api, exemptee du mot de passe du site cote nginx) plutot
 * qu'ici : ce routeur ne gere que les actions depuis l'application
 * (upload, liste, suppression), toutes derriere l'authentification du
 * site comme le reste de l'app.
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // meme limite que le module Reseaux sociaux
  fileFilter: (_req, file, cb) => {
    if (!TYPES_IMAGE_REALISATIONS[file.mimetype]) {
      return cb(new Error(`Type de fichier non autorisé : "${file.mimetype}" (JPEG, PNG ou WebP uniquement).`));
    }
    cb(null, true);
  },
});

export function buildRealisationsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/activites", async (_req, res) => {
    res.json(await listerActivitesRealisations(prisma));
  });

  router.patch("/activites/:id", async (req, res) => {
    const { email } = req.body || {};
    if (typeof email !== "string") return res.status(400).json({ erreur: "'email' requis." });
    try {
      await modifierEmailActiviteRealisation(prisma, req.params.id, email.trim());
      res.status(204).end();
    } catch (err) {
      if (err instanceof ActiviteRealisationError) return res.status(400).json({ erreur: err.message });
      res.status(404).json({ erreur: (err as Error).message });
    }
  });

  router.post("/", (req, res) => {
    // "photos" (pluriel) : plusieurs fichiers en un seul envoi, jusqu'a 20 -
    // demande explicite de l'utilisateur ("choisir les photos" une seule
    // fois, pas une par une).
    upload.array("photos", 20)(req, res, async (err) => {
      if (err) return res.status(400).json({ erreur: (err as Error).message });
      const fichiers = (req.files as Express.Multer.File[]) || [];
      if (fichiers.length === 0) return res.status(400).json({ erreur: "Aucune photo reçue (champ 'photos' attendu)." });
      const activiteId = typeof req.body?.activiteId === "string" ? req.body.activiteId : "";
      if (!activiteId) return res.status(400).json({ erreur: "'activiteId' requis." });
      try {
        const crees = await ajouterPhotosRealisation(prisma, activiteId, fichiers, req.body?.chantierNom);
        res.status(201).json(crees);
      } catch (err2) {
        if (err2 instanceof ActiviteRealisationError) return res.status(400).json({ erreur: err2.message });
        res.status(500).json({ erreur: (err2 as Error).message });
      }
    });
  });

  router.get("/", async (req, res) => {
    const activiteId = typeof req.query.activiteId === "string" ? req.query.activiteId : undefined;
    res.json(await listerPhotosRealisation(prisma, activiteId));
  });

  router.delete("/:id", async (req, res) => {
    try {
      await supprimerPhotoRealisation(prisma, req.params.id);
      res.status(204).end();
    } catch (err) {
      res.status(404).json({ erreur: (err as Error).message });
    }
  });

  return router;
}
