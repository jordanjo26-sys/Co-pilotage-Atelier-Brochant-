import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import { prisma } from "./db/client";
import { buildRouter } from "./api/routes";
import { buildAuthRouter } from "./api/authRoutes";
import { buildProspectionRouter, buildProspectionTrackingRouter } from "./api/prospectionRoutes";
import { buildTelephonieRouter } from "./api/telephonieRoutes";
import { buildReseauxSociauxRouter } from "./api/reseauxSociauxRoutes";
import { buildPagesJaunesRouter } from "./api/pagesJaunesRoutes";
import { buildRealisationsRouter } from "./api/realisationsRoutes";
import { buildArchiveComptableRouter } from "./api/archiveComptableRoutes";
import { obtenirActiviteParToken, construireGaleriePageHtml } from "./services/realisations";
import { construireVisioClientPageHtml, obtenirJetonPourClient } from "./services/visio";
import { installerRelaisVocal } from "./services/relaisVocal";
import {
  demarrerSurveillanceGmail,
  demarrerRecapQuotidien,
  demarrerAnalyseQuotidienneAds,
  demarrerAnalyseHebdomadairePagesJaunes,
  demarrerSurveillanceStripe,
  demarrerSurveillanceSynec,
  demarrerSurveillanceOvh,
  demarrerDetectionReponsesProspection,
  demarrerEnvoiAutomatiqueCampagnes,
  demarrerRecuperationMessagesSecours,
  demarrerRecapMailsImportants,
  demarrerDigestHebdomadaireRealisations,
} from "./services/scheduler";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Limite par defaut (100kb) trop etroite pour la piece jointe base64
// (photo/PDF) qu'un message Morgane peut transporter (section "assistante
// administrative") - 15mb laisse une marge confortable au-dessus de la
// limite de taille appliquee cote route (voir /morgane/message).
app.use(express.json({ limit: "15mb" }));
app.use("/api", buildRouter(prisma));
app.use("/api/prospection", buildProspectionRouter(prisma));
app.use("/api/prospection/suivi", buildProspectionTrackingRouter(prisma));
app.use("/api/reseaux-sociaux", buildReseauxSociauxRouter(prisma));
app.use("/api/pagesjaunes", buildPagesJaunesRouter(prisma));
app.use("/api/realisations", buildRealisationsRouter(prisma));
app.use("/api/archives-comptables", buildArchiveComptableRouter(prisma));
app.use("/auth", buildAuthRouter(prisma));
// Page de galerie publique (module Realisations) : sans authentification
// (le prestataire externe n'a pas le mot de passe du site), protegee
// uniquement par le jeton imprevisible dans l'URL - voir realisations.ts
// et l'exception nginx dediee dans bootstrap.sh (meme principe que
// /media-publics/, deja exempte pour Facebook/Instagram).
app.get("/galerie-realisations/:token", async (req, res) => {
  const activite = await obtenirActiviteParToken(prisma, req.params.token);
  if (!activite) return res.status(404).send("Galerie introuvable.");
  res.set("Content-Type", "text/html; charset=utf-8").send(await construireGaleriePageHtml(prisma, activite));
});
// Page de visio publique (module Visio) : meme principe que la galerie de
// realisations ci-dessus (jeton imprevisible dans l'URL, pas de mot de
// passe - le client n'a evidemment pas celui du site). L'appel API que
// cette page fait pour obtenir son jeton LiveKit (/visio-client/:token/jeton)
// vit dans ce meme prefixe pour ne demander qu'une seule exception nginx
// (voir bootstrap.sh).
app.get("/visio-client/:token", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").send(construireVisioClientPageHtml(req.params.token));
});
app.get("/visio-client/:token/jeton", async (req, res) => {
  const resultat = await obtenirJetonPourClient(prisma, req.params.token);
  if (!resultat) return res.status(404).json({ erreur: "Lien invalide." });
  res.json(resultat);
});
// Webhooks Twilio du standard telephonique IA (authentifies par signature).
app.use("/telephonie", buildTelephonieRouter(prisma));
// process.cwd() plutot que __dirname : ce dernier depend de la structure de
// sortie de tsc (dist/src/server.js, cf. rootDir "." dans tsconfig.json),
// alors que le repertoire de travail est stable (racine du projet, en local
// comme en production via WorkingDirectory dans le service systemd).
app.use(express.static(path.join(process.cwd(), "public")));

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Outil de reception CSV - Copilote Brochant demarre sur http://localhost:${PORT}`);
});

// Relais vocal temps reel du standard telephonique (WebSocket Twilio
// ConversationRelay, /telephonie/relais).
installerRelaisVocal(server, prisma);

// Instance de secours (scripts/deploy/copilote-brochant-secours.service) :
// sert les requetes pendant le redemarrage de l'instance principale, mais
// ne lance aucune tache planifiee (sinon e-mails et synchronisations en
// double).
if (process.env.PLANIFICATEURS_DESACTIVES !== "true") {
  demarrerSurveillanceGmail(prisma);
  demarrerRecapQuotidien(prisma);
  demarrerAnalyseQuotidienneAds(prisma);
  demarrerAnalyseHebdomadairePagesJaunes(prisma);
  demarrerSurveillanceStripe(prisma);
  demarrerSurveillanceSynec(prisma);
  demarrerSurveillanceOvh(prisma);
  demarrerDetectionReponsesProspection(prisma);
  demarrerEnvoiAutomatiqueCampagnes(prisma);
  demarrerRecuperationMessagesSecours(prisma);
  demarrerRecapMailsImportants(prisma);
  demarrerDigestHebdomadaireRealisations(prisma);
}

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
