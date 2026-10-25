import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import { execSync } from "node:child_process";
import { AddressInfo } from "node:net";
import dotenv from "dotenv";
import { WebSocket } from "ws";
import { relaisVocal, signatureTwilio } from "../src/services/twilio";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

test("relais vocal : TwiML ConversationRelay en francais, accueil echappe", () => {
  const xml = relaisVocal("wss://exemple.fr/telephonie/relais", "Bonjour & bienvenue", "/telephonie/fin-relais");
  assert.ok(xml.includes('<Connect action="/telephonie/fin-relais">'));
  assert.ok(xml.includes('url="wss://exemple.fr/telephonie/relais"'));
  assert.ok(xml.includes('language="fr-FR"'));
  assert.ok(xml.includes('welcomeGreeting="Bonjour &amp; bienvenue"'));
});

test("relais vocal : WebSocket signee, reponse diffusee mot a mot", async (t) => {
  const testDatabaseUrl =
    process.env.TEST_DATABASE_URL ||
    (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/(\?|$)/, "_test$1") : undefined);
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL (ou DATABASE_URL) manquante : voir .env.example.");
  process.env.DATABASE_URL = testDatabaseUrl;
  execSync("npx prisma db push --force-reset --skip-generate", { cwd: path.join(__dirname, ".."), env: process.env, stdio: "pipe" });

  const { PrismaClient } = await import("@prisma/client");
  const { installerRelaisVocal } = await import("../src/services/relaisVocal");
  const prisma = new PrismaClient();

  // Faux client Claude en mode flux : renvoie le texte par morceaux.
  const reponses: { stop_reason: string; content: unknown[] }[] = [];
  const fauxClient = {
    beta: {
      messages: {
        stream: () => {
          const r = reponses.shift()!;
          const ecouteurs: ((t: string) => void)[] = [];
          return {
            on: (_evt: string, cb: (t: string) => void) => ecouteurs.push(cb),
            finalMessage: async () => {
              for (const bloc of r.content as { type: string; text?: string }[]) {
                if (bloc.type === "text") for (const mot of bloc.text!.split(/(?<= )/)) ecouteurs.forEach((cb) => cb(mot));
              }
              return r;
            },
          };
        },
      },
    },
  };

  const server = http.createServer();
  installerRelaisVocal(server, prisma as never, () => fauxClient as never);
  await new Promise<void>((ok) => server.listen(0, ok));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  process.env.TWILIO_AUTH_TOKEN = "jeton";
  process.env.TELEPHONE_URL_PUBLIQUE = base;

  await t.test("signature absente : connexion refusee", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/telephonie/relais`);
    const erreur = await new Promise<Error>((ok) => ws.on("error", ok));
    assert.match(erreur.message, /403/);
  });

  await t.test("replique : morceaux de texte puis fin de reponse", async () => {
    reponses.push({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "C'est note, un evier bouche. A quel nom ?" },
        { type: "tool_use", id: "x1", name: "enregistrer_message", input: { motif: "Evier bouche" } },
      ],
    });
    const signature = signatureTwilio("jeton", `wss://127.0.0.1:${port}/telephonie/relais`.replace("wss://", "ws://"), {});
    const ws = new WebSocket(`ws://127.0.0.1:${port}/telephonie/relais`, { headers: { "X-Twilio-Signature": signature } });
    await new Promise((ok) => ws.on("open", ok));
    const recus: { type: string; token?: string; last?: boolean }[] = [];
    const fini = new Promise<void>((ok) =>
      ws.on("message", (d) => {
        const m = JSON.parse(d.toString());
        recus.push(m);
        if (m.last) ok();
      })
    );
    ws.send(JSON.stringify({ type: "setup", callSid: "CA-R1", from: "+33600000009" }));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Mon evier est bouche", last: true }));
    await fini;
    ws.close();

    const morceaux = recus.filter((m) => m.type === "text" && !m.last).map((m) => m.token);
    assert.ok(morceaux.length > 3, "reponse diffusee en plusieurs morceaux");
    assert.equal(morceaux.join(""), "C'est note, un evier bouche. A quel nom ?");
    const appel = await prisma.appel.findUniqueOrThrow({ where: { callSid: "CA-R1" } });
    assert.equal(appel.motif, "Evier bouche");
    assert.equal(appel.numeroAppelant, "+33600000009");
  });

  server.close();
  await prisma.$disconnect();
});
