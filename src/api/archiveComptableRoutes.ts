import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  demarrerImportArchiveZip,
  demarrerImportFichiers,
  demarrerReextractionArchivesIncompletes,
  listerArchivesComptables,
  obtenirArchiveComptable,
  modifierArchiveComptable,
  supprimerArchiveComptable,
} from "../services/archiveComptable";
import { EXTENSIONS_AUTORISEES } from "../importers/zipBulk";
import { CATEGORIES_FACTURE } from "../services/archiveComptableIA";

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

  // Depot direct de plusieurs fichiers PDF/JPEG individuels (pas un ZIP) -
  // demande explicite de l'utilisateur apres un essai reel en video : sur
  // Windows, selectionner un .zip dans la boite de depot du navigateur
  // ouvre parfois l'archive comme un dossier navigable (double-clic sur
  // un "dossier compresse") plutot que de le choisir comme fichier, sans
  // moyen de corriger ca depuis le site. Selectionner directement les
  // PDF/JPEG (ex. Ctrl+A dans le dossier deja extrait) evite ce piege.
  router.post("/import-fichiers", (req, res) => {
    upload.array("fichiers", 500)(req, res, async (err) => {
      if (err) return res.status(400).json({ erreur: (err as Error).message });
      const fichiers = (req.files as Express.Multer.File[] | undefined) || [];
      if (fichiers.length === 0) return res.status(400).json({ erreur: "Aucun fichier reçu (champ 'fichiers' attendu)." });
      // Filtre silencieux par extension (meme liste que l'import ZIP) :
      // un fichier sans rapport glisse dans la meme selection (ex. un
      // .DS_Store ou un recapitulatif) est simplement ignore plutot que
      // de faire echouer tout l'import.
      const retenus = fichiers.filter((f) => EXTENSIONS_AUTORISEES.some((ext) => f.originalname.toLowerCase().endsWith(ext)));
      if (retenus.length === 0) return res.status(400).json({ erreur: "Aucun fichier PDF/JPEG/PNG reconnu parmi les fichiers déposés." });
      try {
        const resultat = await demarrerImportFichiers(
          prisma,
          retenus.map((f) => ({ nom: path.basename(f.originalname), donnees: f.buffer }))
        );
        res.status(202).json(resultat);
      } catch (err2) {
        res.status(400).json({ erreur: (err2 as Error).message });
      }
    });
  });

  // Relance l'extraction sur les archives deja importees mais restees
  // "a verifier" - utile apres un correctif de l'extraction (nouveau
  // libelle reconnu, filet vision...) sans avoir a tout re-deposer.
  router.post("/reextraire", async (req, res) => {
    try {
      const resultat = await demarrerReextractionArchivesIncompletes(prisma);
      res.status(resultat.total > 0 ? 202 : 200).json(resultat);
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  // Liste fixe des categories comptables (voir CATEGORIES_FACTURE) - exposee
  // pour que le filtre cote client reste toujours synchronise avec la liste
  // reellement utilisee par l'IA, sans la dupliquer en dur dans app.js.
  router.get("/categories", (_req, res) => {
    res.json(CATEGORIES_FACTURE);
  });

  router.get("/", async (req, res) => {
    const { dateDebut, dateFin, fournisseurNom, montantMin, montantMax, categorie } = req.query;
    const archives = await listerArchivesComptables(prisma, {
      dateDebut: typeof dateDebut === "string" && dateDebut ? new Date(dateDebut) : undefined,
      dateFin: typeof dateFin === "string" && dateFin ? new Date(dateFin) : undefined,
      fournisseurNom: typeof fournisseurNom === "string" && fournisseurNom ? fournisseurNom : undefined,
      montantMin: typeof montantMin === "string" && montantMin !== "" ? Number(montantMin) : undefined,
      montantMax: typeof montantMax === "string" && montantMax !== "" ? Number(montantMax) : undefined,
      categorie: typeof categorie === "string" && categorie ? categorie : undefined,
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
