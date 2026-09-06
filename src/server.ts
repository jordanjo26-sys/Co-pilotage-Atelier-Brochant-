import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import { prisma } from "./db/client";
import { buildRouter } from "./api/routes";
import { buildAuthRouter } from "./api/authRoutes";
import { demarrerSurveillanceGmail, demarrerRecapQuotidien, demarrerSurveillanceStripe } from "./services/scheduler";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use("/api", buildRouter(prisma));
app.use("/auth", buildAuthRouter(prisma));
// process.cwd() plutot que __dirname : ce dernier depend de la structure de
// sortie de tsc (dist/src/server.js, cf. rootDir "." dans tsconfig.json),
// alors que le repertoire de travail est stable (racine du projet, en local
// comme en production via WorkingDirectory dans le service systemd).
app.use(express.static(path.join(process.cwd(), "public")));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Outil de reception CSV - Copilote Brochant demarre sur http://localhost:${PORT}`);
});

demarrerSurveillanceGmail(prisma);
demarrerRecapQuotidien(prisma);
demarrerSurveillanceStripe(prisma);

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
