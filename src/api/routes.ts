import { Router } from "express";
import multer from "multer";
import { PrismaClient } from "@prisma/client";
import { receiveCsv } from "../services/importService";
import { getDashboardSummary } from "../services/dashboardService";
import { synchroniserGmail } from "../services/gmailSync";
import { envoyerRecapQuotidien, construireRecapQuotidien } from "../services/dailyRecap";
import { envoyerBilanSante, construireBilanSante } from "../services/bilanSante";
import { repondreMorgane, MessageMorgane } from "../services/morgane";
import { getGmailClient } from "../services/googleAuth";

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

  // Note de synthese sur l'etat general de l'activite (CA, tresorerie,
  // documents fournisseurs en attente, points de vigilance) — distincte du
  // recapitulatif quotidien ci-dessus qui ne couvre que les evenements du
  // jour meme.
  router.get("/bilan-sante/apercu", async (_req, res) => {
    const contenu = await construireBilanSante(prisma);
    res.type("text/plain").send(contenu);
  });

  router.post("/bilan-sante/envoyer", async (_req, res) => {
    try {
      await envoyerBilanSante(prisma);
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

  // Previsualisation rapide d'une piece jointe ambigue (bouton "Voir" du
  // centre de validation) : le fichier n'est pas stocke en base (seul son
  // empreinte l'est, pour la deduplication), il est redemande a Gmail a la
  // demande via les references conservees dans les preuves de l'anomalie.
  router.get("/anomalies/:id/document", async (req, res) => {
    const anomalie = await prisma.anomalie.findUnique({ where: { id: req.params.id } });
    if (!anomalie) return res.status(404).json({ erreur: "Anomalie introuvable." });

    let preuves: Record<string, string> = {};
    try {
      preuves = JSON.parse(anomalie.preuves || "{}");
    } catch {
      // preuves illisibles : traite comme absentes ci-dessous
    }
    if (!preuves.messageId || !preuves.attachmentId) {
      return res.status(404).json({ erreur: "Document non disponible pour cette anomalie (pieces jointes plus anciennes)." });
    }

    try {
      const connexionGmail = await getGmailClient(prisma);
      if (!connexionGmail) return res.status(400).json({ erreur: "Gmail non connecte." });
      const { gmail } = connexionGmail;
      const attachment = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: preuves.messageId,
        id: preuves.attachmentId,
      });
      const donnees = Buffer.from(attachment.data.data || "", "base64url");
      res.setHeader("Content-Type", preuves.mimeType || "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(preuves.fichier || "document")}"`);
      res.send(donnees);
    } catch (err) {
      res.status(502).json({ erreur: `Impossible de recuperer le document depuis Gmail : ${(err as Error).message}` });
    }
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

  // Traitement en masse : soit une selection precise (ids, ex. cases cochees
  // dans l'interface), soit un filtre par type (ex. nettoyer un lot genere
  // par un bug de classification desormais corrige). Ne touche que les
  // anomalies actuellement "a_valider".
  router.post("/anomalies/ignorer-en-masse", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === "string") : undefined;
    const type = typeof req.body?.type === "string" ? req.body.type : undefined;
    if (!ids && !type) {
      return res.status(400).json({ erreur: "Fournir soit 'ids' (tableau), soit 'type'." });
    }
    const resultat = await prisma.anomalie.updateMany({
      where: { statut: "a_valider", ...(ids ? { id: { in: ids } } : {}), ...(type ? { type } : {}) },
      data: { statut: "ignoree" },
    });
    res.json({ nombreIgnore: resultat.count });
  });

  // --- Morgane, assistante IA (Phase 7 du cahier des charges) -------------

  router.post("/morgane/message", async (req, res) => {
    const historique = req.body?.historique;
    if (!Array.isArray(historique) || historique.length === 0) {
      return res.status(400).json({ erreur: "Fournir 'historique' (tableau de {role, content})." });
    }
    const valide = historique.every(
      (m: unknown): m is MessageMorgane =>
        !!m &&
        typeof m === "object" &&
        ((m as MessageMorgane).role === "user" || (m as MessageMorgane).role === "assistant") &&
        typeof (m as MessageMorgane).content === "string"
    );
    if (!valide) {
      return res.status(400).json({ erreur: "Chaque message doit avoir 'role' (user|assistant) et 'content' (texte)." });
    }
    try {
      const reponse = await repondreMorgane(prisma, historique);
      res.json({ reponse });
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  return router;
}
