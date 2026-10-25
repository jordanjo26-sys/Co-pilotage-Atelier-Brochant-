import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import { prisma } from "./db/client";
import { buildRouter } from "./api/routes";
import { buildAuthRouter } from "./api/authRoutes";
import { buildProspectionRouter, buildProspectionTrackingRouter } from "./api/prospectionRoutes";
import { buildTelephonieRouter } from "./api/telephonieRoutes";
import { installerRelaisVocal } from "./services/relaisVocal";
import {
  demarrerSurveillanceGmail,
  demarrerRecapQuotidien,
  demarrerAnalyseQuotidienneAds,
  demarrerSurveillanceStripe,
  demarrerSurveillanceSynec,
  demarrerDetectionReponsesProspection,
  demarrerEnvoiAutomatiqueCampagnes,
  demarrerRecuperationMessagesSecours,
  demarrerRecapMailsImportants,
} from "./services/scheduler";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use("/api", buildRouter(prisma));
app.use("/api/prospection", buildProspectionRouter(prisma));
app.use("/api/prospection/suivi", buildProspectionTrackingRouter(prisma));
app.use("/auth", buildAuthRouter(prisma));
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
  demarrerSurveillanceStripe(prisma);
  demarrerSurveillanceSynec(prisma);
  demarrerDetectionReponsesProspection(prisma);
  demarrerEnvoiAutomatiqueCampagnes(prisma);
  demarrerRecuperationMessagesSecours(prisma);
  demarrerRecapMailsImportants(prisma);
}

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
