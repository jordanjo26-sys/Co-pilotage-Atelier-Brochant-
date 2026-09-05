import { Router } from "express";
import multer from "multer";
import { PrismaClient } from "@prisma/client";
import { receiveCsv } from "../services/importService";
import { getDashboardSummary } from "../services/dashboardService";
import { synchroniserGmail } from "../services/gmailSync";
import { envoyerRecapQuotidien, construireRecapQuotidien } from "../services/dailyRecap";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

export function buildRouter(prisma: PrismaClient): Router {
  const router = Router();

  // --- Reception des CSV ------------------------------------------------

  router.post("/import", upload.single("fichier"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ erreur: "Aucun fichier recu (champ attendu : 'fichier')." });
    }
    try {
      const summary = await receiveCsv(prisma, req.file.originalname, req.file.buffer);
      res.status(200).json(summary);
    } catch (err) {
      res.status(500).json({ erreur: (err as Error).message });
    }
  });

  router.get("/imports", async (_req, res) => {
    const imports = await prisma.importBatch.findMany({ orderBy: { dateImport: "desc" }, take: 100 });
    res.json(imports);
  });

  // --- Consultation des donnees normalisees ------------------------------

  router.get("/clients", async (_req, res) => {
    const clients = await prisma.client.findMany({ orderBy: { nom: "asc" }, take: 1000 });
    res.json(clients);
  });

  router.get("/factures", async (req, res) => {
    const statut = typeof req.query.statut === "string" ? req.query.statut : undefined;
    const factures = await prisma.facture.findMany({
      where: statut ? { statut } : undefined,
      orderBy: { dateEcheance: "asc" },
      take: 500,
    });
    res.json(factures);
  });

  router.get("/paiements", async (_req, res) => {
    const paiements = await prisma.paiement.findMany({ orderBy: { date: "desc" }, take: 500 });
    res.json(paiements);
  });

  router.get("/payouts", async (_req, res) => {
    const payouts = await prisma.payout.findMany({ orderBy: { date: "desc" }, take: 500 });
    res.json(payouts);
  });

  // Ventilation d'un payout : quelles factures / paiements le composent.
  router.get("/payouts/:payoutRef/ventilation", async (req, res) => {
    const { payoutRef } = req.params;
    const payout = await prisma.payout.findUnique({ where: { payoutRef } });
    if (!payout) return res.status(404).json({ erreur: "Payout introuvable." });

    const paiements = await prisma.paiement.findMany({ where: { payoutRef } });
    const brutTotal = paiements.reduce((s, p) => s + p.brut, 0);
    const fraisTotal = paiements.reduce((s, p) => s + p.frais, 0);

    res.json({ payout, paiements, brutTotal, fraisTotal, netTotal: brutTotal - fraisTotal });
  });

  router.get("/recapitulatifs-solde", async (_req, res) => {
    const recap = await prisma.recapitulatifSolde.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    res.json(recap);
  });

  router.get("/mouvements-bancaires", async (_req, res) => {
    const mouvements = await prisma.mouvementBancaire.findMany({ orderBy: { date: "desc" }, take: 500 });
    res.json(mouvements);
  });

  router.get("/journal", async (_req, res) => {
    const journal = await prisma.journalEvenement.findMany({ orderBy: { horodatage: "desc" }, take: 200 });
    res.json(journal);
  });

  router.get("/dashboard/summary", async (_req, res) => {
    res.json(await getDashboardSummary(prisma));
  });

  // --- Gmail -> Dext (section 7) ------------------------------------------

  router.get("/gmail/status", async (_req, res) => {
    const connexion = await prisma.gmailConnexion.findFirst({ where: { actif: true } });
    res.json(
      connexion
        ? {
            connecte: true,
            compteEmail: connexion.compteEmail,
            derniereSynchro: connexion.derniereSynchro,
          }
        : { connecte: false }
    );
  });

  // Synchronisation manuelle, en attendant la planification automatique
  // (cron) sur le serveur de production (section 16).
  router.post("/gmail/sync", async (_req, res) => {
    try {
      const resultat = await synchroniserGmail(prisma);
      res.json(resultat);
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  // Apercu du contenu sans envoyer d'e-mail (verification manuelle).
  router.get("/recap/apercu", async (_req, res) => {
    const contenu = await construireRecapQuotidien(prisma);
    res.type("text/plain").send(contenu);
  });

  // Declenchement manuel de l'envoi (test, ou rattrapage si le serveur
  // etait indisponible a l'heure prevue) : en plus de l'envoi automatique
  // quotidien planifie (voir scheduler.ts).
  router.post("/recap/envoyer", async (_req, res) => {
    try {
      await envoyerRecapQuotidien(prisma);
      res.json({ envoye: true });
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.get("/documents-fournisseurs", async (req, res) => {
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const documents = await prisma.documentFournisseur.findMany({
      where: type ? { type } : undefined,
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    res.json(documents);
  });

  router.get("/anomalies", async (req, res) => {
    const statut = typeof req.query.statut === "string" ? req.query.statut : undefined;
    const anomalies = await prisma.anomalie.findMany({
      where: statut ? { statut } : undefined,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json(anomalies);
  });

  const STATUTS_ANOMALIE_VALIDES = ["a_valider", "validee", "ignoree"];

  // Traitement manuel d'une anomalie (section 7.2 : le centre de validation
  // sert justement a decider a la main des cas non reconnus automatiquement).
  // Jamais de suppression : le statut "ignoree" garde une trace, contrairement
  // a une suppression silencieuse.
  router.patch("/anomalies/:id", async (req, res) => {
    const { statut } = req.body || {};
    if (typeof statut !== "string" || !STATUTS_ANOMALIE_VALIDES.includes(statut)) {
      return res.status(400).json({ erreur: `statut invalide, attendu l'un de : ${STATUTS_ANOMALIE_VALIDES.join(", ")}` });
    }
    try {
      const anomalie = await prisma.anomalie.update({ where: { id: req.params.id }, data: { statut } });
      res.json(anomalie);
    } catch (err) {
      res.status(404).json({ erreur: "Anomalie introuvable." });
    }
  });

  // Traitement en masse (ex. nettoyer un lot d'images de signature capturees
  // par erreur avant un correctif de classification) : filtre optionnel par
  // type, ne touche que les anomalies actuellement "a_valider".
  router.post("/anomalies/ignorer-en-masse", async (req, res) => {
    const type = typeof req.body?.type === "string" ? req.body.type : undefined;
    const resultat = await prisma.anomalie.updateMany({
      where: { statut: "a_valider", ...(type ? { type } : {}) },
      data: { statut: "ignoree" },
    });
    res.json({ nombreIgnore: resultat.count });
  });

  return router;
}
