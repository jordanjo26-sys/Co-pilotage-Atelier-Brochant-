import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import { prisma } from "./db/client";
import { buildRouter } from "./api/routes";
import { buildAuthRouter } from "./api/authRoutes";
import { demarrerSurveillanceGmail } from "./services/scheduler";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use("/api", buildRouter(prisma));
app.use("/auth", buildAuthRouter(prisma));
app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Outil de reception CSV - Copilote Brochant demarre sur http://localhost:${PORT}`);
});

demarrerSurveillanceGmail(prisma);

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
