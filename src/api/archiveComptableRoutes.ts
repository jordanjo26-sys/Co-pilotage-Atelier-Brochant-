import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  demarrerImportArchiveZip,
  listerArchivesComptables,
  obtenirArchiveComptable,
  modifierArchiveComptable,
  supprimerArchiveComptable,
} from "../services/archiveComptable";

/**
 * Routes du module Comptabilite (archive de factures independante de
 * Dext, voir archiveComptable.ts). Toutes derriere l'authentification du
 * site comme le reste de l'app - aucune route publique ici.
 */

// Export Dext de plusieurs centaines de fichiers (PDF/JPEG) : limite large,
// volontairement bien au-dessus de la limite generale de l'app (25 Mo) qui
// vise une seule piece jointe, pas une archive complete.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });

export function buildArchiveComptableRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.post("/import", (req, res) => {
    upload.single("archive")(req, res, async (err) => {
      if (err) return res.status(400).json({ erreur: (err as Error).message });
      if (!req.file) return res.status(400).json({ erreur: "Aucune archive reçue (champ 'archive' attendu, fichier .zip)." });
      try {
        const resultat = await demarrerImportArchiveZip(prisma, req.file.buffer);
        res.status(202).json(resultat);
      } catch (err2) {
        res.status(400).json({ erreur: (err2 as Error).message });
      }
    });
  });

  router.get("/", async (req, res) => {
    const { dateDebut, dateFin, fournisseurNom, montantMin, montantMax } = req.query;
    const archives = await listerArchivesComptables(prisma, {
      dateDebut: typeof dateDebut === "string" && dateDebut ? new Date(dateDebut) : undefined,
      dateFin: typeof dateFin === "string" && dateFin ? new Date(dateFin) : undefined,
      fournisseurNom: typeof fournisseurNom === "string" && fournisseurNom ? fournisseurNom : undefined,
      montantMin: typeof montantMin === "string" && montantMin !== "" ? Number(montantMin) : undefined,
      montantMax: typeof montantMax === "string" && montantMax !== "" ? Number(montantMax) : undefined,
    });
    res.json(archives);
  });

  router.get("/:id/fichier", async (req, res) => {
    try {
      const archive = await obtenirArchiveComptable(prisma, req.params.id);
      res.setHeader("Content-Type", archive.mimeType);
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(archive.fichierNom)}"`);
      fs.createReadStream(archive.cheminFichier).pipe(res);
    } catch (err) {
      res.status(404).json({ erreur: (err as Error).message });
    }
  });

  router.patch("/:id", async (req, res) => {
    try {
      const archive = await modifierArchiveComptable(prisma, req.params.id, req.body || {});
      res.json(archive);
    } catch (err) {
      res.status(404).json({ erreur: (err as Error).message });
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      await supprimerArchiveComptable(prisma, req.params.id);
      res.status(204).end();
    } catch (err) {
      res.status(404).json({ erreur: (err as Error).message });
    }
  });

  return router;
}
