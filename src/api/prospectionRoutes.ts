import { Router } from "express";
import multer from "multer";
import { PrismaClient } from "@prisma/client";
import { ajouterProspectManuel, importerProspectsCsv, rechercherEntreprises } from "../services/prospection/sourcing";
import { changerStatutProspect, listerProspects, modifierProspect, obtenirProspect, supprimerProspect } from "../services/prospection/crm";
import { enrichirProspect } from "../services/prospection/enrichissement";
import {
  desabonner,
  enregistrerClic,
  enregistrerOuverture,
  envoyerCampagne,
  envoyerRelance,
  listerProspectsDus,
  listerRelancesDues,
} from "../services/prospection/campagnes";
import { historiqueEnvois, repartitionParStatut, statistiquesCampagnes } from "../services/prospection/dashboard";
import { enregistrerPieceJointe, supprimerPieceJointe, typeAutorise } from "../services/prospection/pieceJointe";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// Plaquette commerciale (PDF/image) : plus volumineuse qu'un CSV, mais
// plafonnee pour rester raisonnable une fois jointe a chaque envoi (limite
// Gmail ~25 Mo par message, encodage base64 inclus).
const uploadPieceJointe = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Pixel de suivi 1x1 transparent (section 2.5 : ouverture d'un envoi).
const PIXEL_TRANSPARENT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

export function buildProspectionRouter(prisma: PrismaClient): Router {
  const router = Router();

  // --- Mini-CRM (section 2.2) --------------------------------------------

  router.get("/prospects", async (req, res) => {
    const { type, statut, marqueProposee, codePostal, recherche } = req.query;
    const prospects = await listerProspects(prisma, {
      type: typeof type === "string" ? type : undefined,
      statut: typeof statut === "string" ? statut : undefined,
      marqueProposee: typeof marqueProposee === "string" ? marqueProposee : undefined,
      codePostal: typeof codePostal === "string" ? codePostal : undefined,
      recherche: typeof recherche === "string" ? recherche : undefined,
    });
    res.json(prospects);
  });

  router.get("/prospects/:id", async (req, res) => {
    const prospect = await obtenirProspect(prisma, req.params.id);
    if (!prospect) return res.status(404).json({ erreur: "Prospect introuvable." });
    res.json(prospect);
  });

  router.post("/prospects", async (req, res) => {
    try {
      const prospect = await ajouterProspectManuel(prisma, req.body);
      res.status(201).json(prospect);
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.patch("/prospects/:id", async (req, res) => {
    try {
      const prospect = await modifierProspect(prisma, req.params.id, req.body);
      res.json(prospect);
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.post("/prospects/:id/statut", async (req, res) => {
    try {
      const prospect = await changerStatutProspect(prisma, req.params.id, req.body.statut, req.body.auteur);
      res.json(prospect);
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.delete("/prospects/:id", async (req, res) => {
    try {
      await supprimerProspect(prisma, req.params.id);
      res.status(204).send();
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.post("/prospects/:id/enrichir", async (req, res) => {
    try {
      const resultat = await enrichirProspect(prisma, req.params.id);
      res.json(resultat);
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  // --- Sourcing (section 2.1) ---------------------------------------------

  router.post("/import", upload.single("fichier"), async (req, res) => {
    if (!req.file) return res.status(400).json({ erreur: "Aucun fichier recu (champ attendu : 'fichier')." });
    try {
      const resume = await importerProspectsCsv(prisma, req.file.originalname, req.file.buffer);
      res.status(200).json(resume);
    } catch (err) {
      res.status(500).json({ erreur: (err as Error).message });
    }
  });

  router.get("/recherche", async (req, res) => {
    const { motCle, zone } = req.query;
    if (typeof motCle !== "string" || typeof zone !== "string") {
      return res.status(400).json({ erreur: "Parametres 'motCle' et 'zone' requis." });
    }
    try {
      const resultats = await rechercherEntreprises(motCle, zone);
      res.json(resultats);
    } catch (err) {
      res.status(503).json({ erreur: (err as Error).message });
    }
  });

  // --- Modeles de mail -----------------------------------------------------

  router.get("/templates", async (_req, res) => {
    res.json(await prisma.emailTemplate.findMany({ orderBy: { createdAt: "desc" } }));
  });

  router.post("/templates", async (req, res) => {
    const { nom, marque, service, objet, corpsHtml } = req.body;
    if (!nom || !objet || !corpsHtml) return res.status(400).json({ erreur: "nom, objet et corpsHtml sont requis." });
    const template = await prisma.emailTemplate.create({ data: { nom, marque, service, objet, corpsHtml } });
    res.status(201).json(template);
  });

  router.patch("/templates/:id", async (req, res) => {
    const { nom, marque, service, objet, corpsHtml } = req.body;
    const template = await prisma.emailTemplate.update({ where: { id: req.params.id }, data: { nom, marque, service, objet, corpsHtml } });
    res.json(template);
  });

  router.delete("/templates/:id", async (req, res) => {
    const template = await prisma.emailTemplate.findUnique({ where: { id: req.params.id } });
    await supprimerPieceJointe(template?.pieceJointeChemin);
    await prisma.emailTemplate.delete({ where: { id: req.params.id } });
    res.status(204).send();
  });

  router.post("/templates/:id/piece-jointe", uploadPieceJointe.single("pieceJointe"), async (req, res) => {
    if (!req.file) return res.status(400).json({ erreur: "Aucun fichier recu (champ attendu : 'pieceJointe')." });
    if (!typeAutorise(req.file.mimetype)) {
      return res.status(400).json({ erreur: "Format non accepte : PDF, PNG ou JPEG uniquement." });
    }
    try {
      const template = await prisma.emailTemplate.findUniqueOrThrow({ where: { id: req.params.id } });
      await supprimerPieceJointe(template.pieceJointeChemin);
      const piece = await enregistrerPieceJointe(req.file.originalname, req.file.mimetype, req.file.buffer);
      const misAJour = await prisma.emailTemplate.update({
        where: { id: req.params.id },
        data: { pieceJointeChemin: piece.chemin, pieceJointeNom: piece.nom, pieceJointeType: piece.type },
      });
      res.status(200).json(misAJour);
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.delete("/templates/:id/piece-jointe", async (req, res) => {
    const template = await prisma.emailTemplate.findUnique({ where: { id: req.params.id } });
    if (!template) return res.status(404).json({ erreur: "Modele introuvable." });
    await supprimerPieceJointe(template.pieceJointeChemin);
    const misAJour = await prisma.emailTemplate.update({
      where: { id: req.params.id },
      data: { pieceJointeChemin: null, pieceJointeNom: null, pieceJointeType: null },
    });
    res.json(misAJour);
  });

  // --- Campagnes (section 2.4) ---------------------------------------------

  router.get("/campagnes", async (_req, res) => {
    res.json(await prisma.campagne.findMany({ include: { template: true }, orderBy: { createdAt: "desc" } }));
  });

  router.post("/campagnes", async (req, res) => {
    const { nom, templateId, segmentFiltre, relanceApresJours, arretSiReponse, automatique } = req.body;
    if (!nom || !templateId) return res.status(400).json({ erreur: "nom et templateId sont requis." });
    const campagne = await prisma.campagne.create({
      data: {
        nom,
        templateId,
        segmentFiltre: JSON.stringify(segmentFiltre || {}),
        relanceApresJours: relanceApresJours ?? null,
        arretSiReponse: arretSiReponse ?? true,
        automatique: automatique ?? false,
      },
    });
    res.status(201).json(campagne);
  });

  router.patch("/campagnes/:id", async (req, res) => {
    const { automatique, relanceApresJours, arretSiReponse } = req.body;
    try {
      const campagne = await prisma.campagne.update({
        where: { id: req.params.id },
        data: {
          automatique: typeof automatique === "boolean" ? automatique : undefined,
          relanceApresJours: relanceApresJours === undefined ? undefined : relanceApresJours,
          arretSiReponse: typeof arretSiReponse === "boolean" ? arretSiReponse : undefined,
        },
      });
      res.json(campagne);
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.get("/campagnes/:id/prospects-dus", async (req, res) => {
    try {
      const prospects = await listerProspectsDus(prisma, req.params.id);
      res.json(prospects);
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.post("/campagnes/:id/envoyer", async (req, res) => {
    try {
      const resultat = await envoyerCampagne(prisma, req.params.id);
      res.json(resultat);
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.get("/relances-dues", async (_req, res) => {
    res.json(await listerRelancesDues(prisma));
  });

  router.post("/campagnes/:id/relancer/:prospectId", async (req, res) => {
    try {
      await envoyerRelance(prisma, req.params.id, req.params.prospectId);
      res.status(204).send();
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  // --- Tableau de bord (section 2.5) ---------------------------------------

  router.get("/dashboard/statuts", async (_req, res) => {
    res.json(await repartitionParStatut(prisma));
  });

  router.get("/dashboard/campagnes", async (_req, res) => {
    res.json(await statistiquesCampagnes(prisma));
  });

  router.get("/dashboard/envois", async (_req, res) => {
    res.json(await historiqueEnvois(prisma));
  });

  return router;
}

/**
 * Endpoints de suivi/desabonnement (pixel, clic, desinscription), appeles
 * directement par le client de messagerie du destinataire : volontairement
 * hors du prefixe /api/prospection (pas d'authentification, urls courtes et
 * stables inserees dans les e-mails envoyes).
 */
export function buildProspectionTrackingRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/ouverture/:token.png", async (req, res) => {
    await enregistrerOuverture(prisma, req.params.token).catch(() => undefined);
    res.set("Content-Type", "image/png");
    res.send(PIXEL_TRANSPARENT);
  });

  router.get("/clic/:token", async (req, res) => {
    const urlOrigine = typeof req.query.u === "string" ? req.query.u : null;
    if (!urlOrigine) return res.status(400).send("Lien invalide.");
    try {
      const cible = await enregistrerClic(prisma, req.params.token, urlOrigine);
      res.redirect(cible);
    } catch {
      res.redirect(urlOrigine);
    }
  });

  router.get("/desabonnement/:token", async (req, res) => {
    const prospect = await desabonner(prisma, req.params.token);
    if (!prospect) return res.status(404).send("<p>Lien de desinscription invalide ou expire.</p>");
    res.send(`<p>${prospect.entreprise} a bien ete desinscrit(e). Vous ne recevrez plus de message de notre part.</p>`);
  });

  return router;
}
