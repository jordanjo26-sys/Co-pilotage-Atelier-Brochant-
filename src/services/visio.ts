import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import { PrismaClient } from "@prisma/client";
import { AccessToken } from "livekit-server-sdk";
import { TrackSource } from "@livekit/protocol";
import { envoyerSmsA } from "./twilio";
import { logEvenement } from "./journalService";

/**
 * Module Visio (devis a distance) : un client appelle sans rendez-vous sur
 * place et l'utilisateur veut lui montrer/faire un devis a distance, en
 * voyant le client sans jamais etre vu (demande explicite). Aucun modele
 * "Devis" n'existe dans cette base (les devis sont crees directement dans
 * Synec, logiciel tiers sans API - voir synecDevis.ts) : une session visio
 * est donc autonome, son seul resultat durable est le PDF recapitulatif
 * genere a partir des captures prises pendant l'appel.
 *
 * Video a sens unique garantie par le serveur LiveKit lui-meme, pas
 * seulement par le code front : le jeton de l'utilisateur restreint
 * canPublishSources a MICROPHONE uniquement (voir genererJetonUtilisateur)
 * - meme un bug ou une modification du front ne pourrait jamais publier sa
 * camera, LiveKit refuserait la piste cote serveur.
 */

const DOSSIER_VISIO = path.join(process.cwd(), "uploads", "visio");

export class VisioError extends Error {}

export function visioEstConfiguree(): boolean {
  return Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
}

function obtenirConfigLivekit(): { url: string; apiKey: string; apiSecret: string } {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) {
    throw new VisioError("Visio non configuree (LIVEKIT_URL, LIVEKIT_API_KEY et LIVEKIT_API_SECRET requis).");
  }
  return { url, apiKey, apiSecret };
}

function construireUrlClient(token: string): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) {
    throw new VisioError("PUBLIC_BASE_URL manquante dans .env (ex. https://copilotage-brochant.fr) - necessaire pour construire le lien de visio.");
  }
  return `${base.replace(/\/$/, "")}/visio-client/${token}`;
}

export interface SessionVisioCreee {
  id: string;
  clientNom: string;
  clientTelephone: string | null;
  token: string;
  statut: string;
  livekitRoom: string;
  createdAt: Date;
}

export async function creerSession(
  prisma: PrismaClient,
  params: { clientNom: string; clientTelephone?: string | null }
): Promise<{ session: SessionVisioCreee; lienClient: string; smsEnvoye: boolean }> {
  const clientNom = params.clientNom?.trim();
  if (!clientNom) {
    throw new VisioError("Le nom du client est obligatoire.");
  }
  obtenirConfigLivekit();

  const session = await prisma.sessionVisio.create({
    data: {
      clientNom,
      clientTelephone: params.clientTelephone?.trim() || null,
      token: crypto.randomBytes(24).toString("hex"),
      livekitRoom: `visio-${crypto.randomBytes(8).toString("hex")}`,
    },
  });

  const lienClient = construireUrlClient(session.token);

  // Envoi du lien par SMS : jamais bloquant pour la creation de la session
  // (meme principe que l'envoi Dext automatique dans documentsScannes.ts) -
  // sans telephone ou en cas d'echec, Jordan recupere le lien affiche dans
  // l'ecran et l'envoie lui-meme (copier/coller).
  let smsEnvoye = false;
  if (session.clientTelephone) {
    try {
      await envoyerSmsA(
        session.clientTelephone,
        `Atelier Brochant : voici le lien pour votre devis en visio : ${lienClient}`
      );
      smsEnvoye = true;
    } catch {
      // Echec silencieux : le lien reste disponible a l'ecran pour envoi manuel.
    }
  }

  await logEvenement(prisma, {
    evenement: "visio_session_creee",
    action: `Session visio creee pour ${clientNom}`,
    resultat: smsEnvoye ? "Lien envoye par SMS." : "Lien a transmettre manuellement.",
  });

  return { session, lienClient, smsEnvoye };
}

export async function obtenirSessionParToken(prisma: PrismaClient, token: string) {
  return prisma.sessionVisio.findUnique({ where: { token } });
}

/**
 * Appelee par la page publique (/visio-client/:token/jeton, sans mot de
 * passe du site) quand le client ouvre le lien : genere son jeton LiveKit
 * et bascule la session en "en_cours" des sa premiere connexion (jamais a
 * la creation, qui ne garantit pas que le client ait effectivement rejoint).
 */
export async function obtenirJetonPourClient(
  prisma: PrismaClient,
  token: string
): Promise<{ livekitUrl: string; jetonClient: string; statut: string } | null> {
  const session = await prisma.sessionVisio.findUnique({ where: { token } });
  if (!session) return null;
  const { jeton, url } = await genererJetonClient(session);
  if (session.statut === "en_attente") {
    await prisma.sessionVisio.update({ where: { id: session.id }, data: { statut: "en_cours", dateDebut: new Date() } });
  }
  return { livekitUrl: url, jetonClient: jeton, statut: session.statut === "en_attente" ? "en_cours" : session.statut };
}

export async function obtenirSession(prisma: PrismaClient, id: string) {
  return prisma.sessionVisio.findUnique({ where: { id }, include: { captures: { orderBy: { createdAt: "asc" } } } });
}

export async function listerSessions(prisma: PrismaClient) {
  return prisma.sessionVisio.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
}

export async function changerStatutSession(prisma: PrismaClient, id: string, statut: string) {
  const STATUTS_VALIDES = ["en_attente", "en_cours", "terminee"];
  if (!STATUTS_VALIDES.includes(statut)) {
    throw new VisioError(`Statut invalide, attendu l'un de : ${STATUTS_VALIDES.join(", ")}.`);
  }
  const data: { statut: string; dateDebut?: Date; dateFin?: Date } = { statut };
  if (statut === "en_cours") data.dateDebut = new Date();
  if (statut === "terminee") data.dateFin = new Date();
  return prisma.sessionVisio.update({ where: { id }, data });
}

/**
 * Jeton LiveKit pour l'utilisateur (Jordan) : peut publier uniquement son
 * micro (jamais sa camera, restriction imposee par le serveur LiveKit via
 * canPublishSources) et peut s'abonner a tout (la camera du client).
 */
export async function genererJetonUtilisateur(session: { livekitRoom: string }): Promise<{ jeton: string; url: string }> {
  const { url, apiKey, apiSecret } = obtenirConfigLivekit();
  const at = new AccessToken(apiKey, apiSecret, { identity: "jordan" });
  at.addGrant({
    roomJoin: true,
    room: session.livekitRoom,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
  });
  return { jeton: await at.toJwt(), url };
}

/**
 * Jeton LiveKit pour le client : peut publier camera+micro (c'est lui qui
 * doit etre vu/entendu) et s'abonner (pour entendre Jordan - jamais le
 * voir puisqu'aucune piste camera de sa part n'existera jamais, voir
 * ci-dessus).
 */
export async function genererJetonClient(session: { livekitRoom: string }): Promise<{ jeton: string; url: string }> {
  const { url, apiKey, apiSecret } = obtenirConfigLivekit();
  const at = new AccessToken(apiKey, apiSecret, { identity: "client" });
  at.addGrant({
    roomJoin: true,
    room: session.livekitRoom,
    canPublish: true,
    canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
    canSubscribe: true,
  });
  return { jeton: await at.toJwt(), url };
}

export interface MesuresCapture {
  referencePoints: [{ x: number; y: number }, { x: number; y: number }];
  referenceLongueurCm: number;
  mesurePoints: [{ x: number; y: number }, { x: number; y: number }];
  distanceCalculeeCm: number;
}

export async function enregistrerCapture(
  prisma: PrismaClient,
  sessionId: string,
  params: { image: Buffer; mesures?: MesuresCapture }
) {
  const session = await prisma.sessionVisio.findUnique({ where: { id: sessionId } });
  if (!session) throw new VisioError("Session visio introuvable.");

  await fs.mkdir(DOSSIER_VISIO, { recursive: true });
  const fichierNom = `${crypto.randomUUID()}.png`;
  await fs.writeFile(path.join(DOSSIER_VISIO, fichierNom), params.image);

  return prisma.captureVisio.create({
    data: {
      sessionId,
      fichierNom,
      mesures: params.mesures ? JSON.stringify(params.mesures) : null,
    },
  });
}

/**
 * Mesure ajoutee apres coup sur une capture deja prise (bouton "Mesurer"
 * depuis l'historique, pas forcement pendant l'appel) - demande explicite
 * de l'utilisateur : la mesure est occasionnelle, pas systematique a la
 * capture.
 */
export async function mettreAJourMesuresCapture(prisma: PrismaClient, captureId: string, mesures: MesuresCapture) {
  const capture = await prisma.captureVisio.findUnique({ where: { id: captureId } });
  if (!capture) throw new VisioError("Capture introuvable.");
  return prisma.captureVisio.update({ where: { id: captureId }, data: { mesures: JSON.stringify(mesures) } });
}

export function cheminCaptureVisio(fichierNom: string): string {
  return path.join(DOSSIER_VISIO, fichierNom);
}

function construirePdfRecapitulatif(
  session: { clientNom: string; clientTelephone: string | null; createdAt: Date },
  captures: { fichierNom: string; mesures: string | null; createdAt: Date }[]
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const morceaux: Buffer[] = [];
    doc.on("data", (m) => morceaux.push(m));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(18).text("Récapitulatif de visio - devis à distance");
    doc.moveDown(0.3);
    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor("#444444")
      .text(`Client : ${session.clientNom}`)
      .text(session.clientTelephone ? `Téléphone : ${session.clientTelephone}` : "")
      .text(`Date de l'appel : ${session.createdAt.toLocaleDateString("fr-FR")}`);
    doc.fillColor("#000000");
    doc.moveDown(1);

    if (captures.length === 0) {
      doc.font("Helvetica").fontSize(11).text("Aucune capture prise pendant cet appel.");
    }

    for (const [index, capture] of captures.entries()) {
      if (index > 0) doc.addPage();
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .text(`Capture ${index + 1} - ${capture.createdAt.toLocaleTimeString("fr-FR")}`);
      doc.moveDown(0.3);
      const largeurDispo = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      try {
        doc.image(cheminCaptureVisio(capture.fichierNom), { fit: [largeurDispo, 420], align: "center" });
      } catch {
        doc.font("Helvetica").fontSize(10).fillColor("#aa0000").text("(image introuvable)").fillColor("#000000");
      }
      doc.moveDown(0.5);
      if (capture.mesures) {
        try {
          const m: MesuresCapture = JSON.parse(capture.mesures);
          doc
            .font("Helvetica")
            .fontSize(11)
            .text(
              `Mesure approximative : ${m.distanceCalculeeCm.toFixed(1)} cm (calibrée sur une référence de ${m.referenceLongueurCm} cm - suppose un plan similaire entre référence et mesure).`
            );
        } catch {
          // mesures illisibles : ignore silencieusement, l'image seule reste utile.
        }
      }
    }

    doc.end();
  });
}

export async function genererPdfRecapitulatif(prisma: PrismaClient, sessionId: string): Promise<Buffer> {
  const session = await prisma.sessionVisio.findUnique({
    where: { id: sessionId },
    include: { captures: { orderBy: { createdAt: "asc" } } },
  });
  if (!session) throw new VisioError("Session visio introuvable.");
  return construirePdfRecapitulatif(session, session.captures);
}

// Version pinnee du build UMD (sans bundler cote front, comme le reste de
// public/app.js) - a mettre a jour manuellement si besoin, jamais "latest".
const VERSION_LIVEKIT_CLIENT_CDN = "2.24.1";

/**
 * Page que le client ouvre (lien recu par SMS), servie par
 * /visio-client/:token dans server.ts, SANS mot de passe du site (exception
 * nginx dediee) : CSS et JS entierement inline, /app.js et /styles.css
 * restant eux derriere le mot de passe. Le token est un hex genere par
 * crypto.randomBytes (voir creerSession), jamais une valeur utilisateur :
 * aucun echappement HTML necessaire pour l'interpoler dans le <script>.
 */
export function construireVisioClientPageHtml(token: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Visio — Atelier Brochant</title>
  <style>
    :root { color-scheme: light; }
    body { margin:0; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; font-family:'IBM Plex Sans',Arial,Helvetica,sans-serif; background:#16213E; color:#F3F6FB; padding:16px; box-sizing:border-box; }
    #etat { font-size:15px; text-align:center; max-width:420px; }
    #video-locale { width:100%; max-width:420px; border-radius:12px; background:#000; aspect-ratio:4/3; object-fit:cover; }
    #controles { display:flex; gap:12px; }
    #controles[hidden], #video-locale[hidden] { display:none; }
    button { font-size:15px; padding:12px 20px; border-radius:10px; border:none; background:#3D6BFF; color:#fff; }
    button#btn-raccrocher { background:#D64545; }
  </style>
</head>
<body>
  <div id="etat">Connexion en cours…</div>
  <video id="video-locale" autoplay playsinline muted hidden></video>
  <div id="controles" hidden>
    <button type="button" id="btn-micro">Couper le micro</button>
    <button type="button" id="btn-raccrocher">Raccrocher</button>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/livekit-client@${VERSION_LIVEKIT_CLIENT_CDN}/dist/livekit-client.umd.min.js"></script>
  <script>
    (function () {
      var token = ${JSON.stringify(token)};
      var etat = document.getElementById("etat");
      var videoLocale = document.getElementById("video-locale");
      var controles = document.getElementById("controles");
      var btnMicro = document.getElementById("btn-micro");
      var btnRaccrocher = document.getElementById("btn-raccrocher");
      var room = null;

      async function demarrer() {
        var reponse;
        try {
          reponse = await fetch("/visio-client/" + token + "/jeton");
        } catch (e) {
          etat.textContent = "Connexion impossible (réseau).";
          return;
        }
        if (!reponse.ok) {
          etat.textContent = "Lien invalide ou appel déjà terminé.";
          return;
        }
        var donnees = await reponse.json();
        room = new LivekitClient.Room();
        try {
          await room.connect(donnees.livekitUrl, donnees.jetonClient);
          await room.localParticipant.setMicrophoneEnabled(true);
          await room.localParticipant.setCameraEnabled(true);
        } catch (e) {
          etat.textContent = "Caméra/micro refusés ou indisponibles : autorisez-les puis rechargez la page.";
          return;
        }
        var publicationVideo = Array.from(room.localParticipant.videoTrackPublications.values())[0];
        if (publicationVideo && publicationVideo.videoTrack) {
          publicationVideo.videoTrack.attach(videoLocale);
          videoLocale.hidden = false;
        }
        etat.textContent = "Vous êtes en relation avec Atelier Brochant.";
        controles.hidden = false;
      }

      btnMicro.addEventListener("click", function () {
        if (!room) return;
        var actif = room.localParticipant.isMicrophoneEnabled;
        room.localParticipant.setMicrophoneEnabled(!actif);
        btnMicro.textContent = actif ? "Activer le micro" : "Couper le micro";
      });

      btnRaccrocher.addEventListener("click", function () {
        if (room) room.disconnect();
        etat.textContent = "Appel terminé. Vous pouvez fermer cette page.";
        controles.hidden = true;
        videoLocale.hidden = true;
      });

      demarrer();
    })();
  </script>
</body>
</html>`;
}
