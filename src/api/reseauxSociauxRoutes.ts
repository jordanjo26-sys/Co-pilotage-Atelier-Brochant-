import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { obtenirConnexionMeta } from "../services/metaAuth";
import { creerPropositionPost, listerPropositionsPost, accepterPropositionPost, refuserPropositionPost } from "../services/reseauxSociauxActions";

/**
 * Routes du module Reseaux sociaux (upload de media, propositions de
 * publication). Meme principe de validation explicite que Google Ads : ces
 * routes ne publient jamais directement, seul /propositions/:id/accepter
 * declenche une vraie publication, et uniquement sur une proposition deja
 * deposee avec l'accord de l'utilisateur.
 */

const TYPES_IMAGE_AUTORISES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 Mo : large pour une photo, raisonnable pour un VPS modeste
  fileFilter: (_req, file, cb) => {
    if (!TYPES_IMAGE_AUTORISES[file.mimetype]) {
      return cb(new Error(`Type de fichier non autorise : "${file.mimetype}" (JPEG, PNG ou WebP uniquement).`));
    }
    cb(null, true);
  },
});

const DOSSIER_MEDIA_PUBLICS = path.join(process.cwd(), "public", "media-publics");

export function buildReseauxSociauxRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/connexion", async (_req, res) => {
    const connexion = await obtenirConnexionMeta(prisma);
    res.json(
      connexion
        ? { connecte: true, pageNom: connexion.pageNom, instagramUsername: connexion.instagramUsername }
        : { connecte: false }
    );
  });

  router.post("/media", (req, res) => {
    upload.single("fichier")(req, res, async (err) => {
      if (err) return res.status(400).json({ erreur: (err as Error).message });
      if (!req.file) return res.status(400).json({ erreur: "Aucun fichier recu (champ 'fichier' attendu)." });

      try {
        await fs.mkdir(DOSSIER_MEDIA_PUBLICS, { recursive: true });
        const extension = TYPES_IMAGE_AUTORISES[req.file.mimetype];
        const nomFichier = `${crypto.randomUUID()}.${extension}`;
        await fs.writeFile(path.join(DOSSIER_MEDIA_PUBLICS, nomFichier), req.file.buffer);
        res.json({ chemin: `media-publics/${nomFichier}` });
      } catch (err2) {
        res.status(500).json({ erreur: (err2 as Error).message });
      }
    });
  });

  router.get("/propositions", async (req, res) => {
    const statut = typeof req.query.statut === "string" ? req.query.statut : undefined;
    res.json(await listerPropositionsPost(prisma, statut));
  });

  router.post("/propositions", async (req, res) => {
    try {
      res.json(
        await creerPropositionPost(prisma, {
          plateformes: Array.isArray(req.body?.plateformes) ? req.body.plateformes : [],
          texte: typeof req.body?.texte === "string" ? req.body.texte : "",
          cheminMedia: typeof req.body?.cheminMedia === "string" ? req.body.cheminMedia : undefined,
          justification: typeof req.body?.justification === "string" ? req.body.justification : "Proposition deposee depuis l'onglet Reseaux sociaux.",
        })
      );
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.post("/propositions/:id/accepter", async (req, res) => {
    try {
      res.json(await accepterPropositionPost(prisma, req.params.id));
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.post("/propositions/:id/refuser", async (req, res) => {
    try {
      res.json(await refuserPropositionPost(prisma, req.params.id));
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  return router;
}
