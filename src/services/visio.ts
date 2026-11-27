import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import { PrismaClient } from "@prisma/client";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
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

/**
 * Diagnostic : verifie que LIVEKIT_API_KEY/LIVEKIT_API_SECRET tels que
 * charges par CE processus correspondent bien a une paire valide pour le
 * projet LIVEKIT_URL, en appelant l'API REST d'administration (signee par
 * la paire cle/secret, aucun navigateur/WebRTC requis). Isole precisement
 * "la paire stockee est-elle correcte" de "la connexion WebRTC d'un client
 * particulier marche-t-elle" - utile pour diagnostiquer un probleme de
 * transport du secret (GitHub -> SSH -> bootstrap.sh -> .env) independamment
 * de tout test de visio reel.
 */
export async function diagnostiquerLivekit(): Promise<{ ok: boolean; message: string }> {
  const { url, apiKey, apiSecret } = obtenirConfigLivekit();
  const client = new RoomServiceClient(url.replace(/^wss:/, "https:"), apiKey, apiSecret);
  try {
    const rooms = await client.listRooms();
    return { ok: true, message: `Cle/secret valides pour ce projet LiveKit (${rooms.length} room(s) actuellement).` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
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
export interface ConsentementVisio {
  accepte: boolean;
  cameraMicro: boolean;
  photos: boolean;
}

/**
 * Appelee par la page publique (/visio-client/:token/jeton, sans mot de
 * passe du site) quand le client ouvre le lien : revalide le consentement
 * RGPD cote serveur (jamais confiance seule a la case cochee cote client,
 * voir construireVisioClientPageHtml) avant de generer son jeton LiveKit et
 * de basculer la session en "en_cours" des sa premiere connexion (jamais a
 * la creation, qui ne garantit pas que le client ait effectivement rejoint).
 * Le consentement n'est enregistre qu'une fois (premiere connexion) - un
 * rechargement de page ulterieur ne l'ecrase pas.
 */
export async function obtenirJetonPourClient(
  prisma: PrismaClient,
  token: string,
  consentement: ConsentementVisio
): Promise<{ livekitUrl: string; jetonClient: string; statut: string } | null> {
  if (!consentement.accepte || !consentement.cameraMicro || !consentement.photos) {
    throw new VisioError("Les 3 cases de consentement doivent être acceptées pour accéder à la visio.");
  }
  const session = await prisma.sessionVisio.findUnique({ where: { token } });
  if (!session) return null;
  const { jeton, url } = await genererJetonClient(session);
  const data: { statut?: string; dateDebut?: Date; consentAccepte?: boolean; consentCameraMicro?: boolean; consentPhotos?: boolean; consentDate?: Date } = {};
  if (session.statut === "en_attente") {
    data.statut = "en_cours";
    data.dateDebut = new Date();
  }
  if (!session.consentDate) {
    data.consentAccepte = true;
    data.consentCameraMicro = true;
    data.consentPhotos = true;
    data.consentDate = new Date();
  }
  if (Object.keys(data).length > 0) {
    await prisma.sessionVisio.update({ where: { id: session.id }, data });
  }
  return { livekitUrl: url, jetonClient: jeton, statut: session.statut === "en_attente" ? "en_cours" : session.statut };
}

export async function obtenirSession(prisma: PrismaClient, id: string) {
  return prisma.sessionVisio.findUnique({ where: { id }, include: { captures: { orderBy: { createdAt: "asc" } } } });
}

const PAR_PAGE_DEFAUT_VISIO = 25;

export interface FiltresSessionsVisio {
  statut?: "en_attente" | "en_cours" | "terminee";
  recherche?: string;
  dateDebut?: string;
  dateFin?: string;
  archive?: boolean;
  page?: number;
  parPage?: number;
}

export interface ResultatSessionsVisio {
  sessions: Awaited<ReturnType<PrismaClient["sessionVisio"]["findMany"]>>;
  total: number;
  compteurs: { enAttente: number; enCours: number; terminees: number };
  page: number;
  parPage: number;
}

/**
 * Historique des sessions visio, avec recherche/filtres/pagination - meme
 * convention que listerFacturesFournisseursUnifiees (facturesFournisseursUnifiees.ts) :
 * `archive` bascule entre l'historique actif (defaut, archivee=false) et la
 * corbeille (archivee=true), jamais les deux melanges. Les compteurs sont
 * toujours calcules sur l'ensemble actif (non-archive), independamment de la
 * pagination/recherche en cours, pour que les tuiles cliquables du tableau
 * de bord restent stables pendant qu'on filtre la liste.
 */
export async function listerSessions(
  prisma: PrismaClient,
  filtres: FiltresSessionsVisio = {}
): Promise<ResultatSessionsVisio> {
  const archive = Boolean(filtres.archive);

  const ou: Record<string, unknown> = { archivee: archive };
  if (filtres.statut) ou.statut = filtres.statut;
  if (filtres.recherche?.trim()) {
    ou.clientNom = { contains: filtres.recherche.trim(), mode: "insensitive" };
  }
  if (filtres.dateDebut || filtres.dateFin) {
    ou.createdAt = {
      ...(filtres.dateDebut ? { gte: new Date(`${filtres.dateDebut}T00:00:00`) } : {}),
      ...(filtres.dateFin ? { lte: new Date(`${filtres.dateFin}T23:59:59.999`) } : {}),
    };
  }

  const parPage = filtres.parPage && filtres.parPage > 0 ? filtres.parPage : PAR_PAGE_DEFAUT_VISIO;
  const page = filtres.page && filtres.page > 0 ? filtres.page : 1;

  const [sessions, total, enAttente, enCours, terminees] = await Promise.all([
    prisma.sessionVisio.findMany({
      where: ou,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * parPage,
      take: parPage,
    }),
    prisma.sessionVisio.count({ where: ou }),
    prisma.sessionVisio.count({ where: { archivee: archive, statut: "en_attente" } }),
    prisma.sessionVisio.count({ where: { archivee: archive, statut: "en_cours" } }),
    prisma.sessionVisio.count({ where: { archivee: archive, statut: "terminee" } }),
  ]);

  return { sessions, total, compteurs: { enAttente, enCours, terminees }, page, parPage };
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

export async function mettreAJourNotes(prisma: PrismaClient, id: string, notes: string) {
  const session = await prisma.sessionVisio.findUnique({ where: { id } });
  if (!session) throw new VisioError("Session visio introuvable.");
  return prisma.sessionVisio.update({ where: { id }, data: { notes: notes.trim() || null } });
}

/**
 * Archivage = corbeille : masque la session de l'historique actif sans rien
 * supprimer (demande explicite de l'utilisateur, "suppression réversible").
 * Autorise a tout statut sauf en_cours (un appel en cours ne doit jamais
 * disparaitre de la liste active).
 */
export async function archiverSession(prisma: PrismaClient, id: string) {
  const session = await prisma.sessionVisio.findUnique({ where: { id } });
  if (!session) throw new VisioError("Session visio introuvable.");
  if (session.statut === "en_cours") {
    throw new VisioError("Impossible d'archiver une visite en cours.");
  }
  if (session.archivee) return session;
  return prisma.sessionVisio.update({ where: { id }, data: { archivee: true, archivedAt: new Date() } });
}

export async function restaurerSession(prisma: PrismaClient, id: string) {
  const session = await prisma.sessionVisio.findUnique({ where: { id } });
  if (!session) throw new VisioError("Session visio introuvable.");
  if (!session.archivee) return session;
  return prisma.sessionVisio.update({ where: { id }, data: { archivee: false, archivedAt: null } });
}

/**
 * Suppression definitive d'une visite (demande explicite de l'utilisateur :
 * suppression directe, l'archivage n'est qu'une option de rangement, jamais
 * un prealable obligatoire) - autorisee pour tout statut sauf en_cours (un
 * appel actif ne doit jamais pouvoir disparaitre). Verifie les dependances
 * (CaptureVisio porte une contrainte ON DELETE RESTRICT vers SessionVisio,
 * voir migration initiale) en supprimant d'abord chaque fichier image sur
 * disque puis chaque ligne CaptureVisio, avant de supprimer la session
 * elle-meme.
 */
export async function supprimerSessionDefinitivement(prisma: PrismaClient, id: string) {
  const session = await prisma.sessionVisio.findUnique({
    where: { id },
    include: { captures: true },
  });
  if (!session) throw new VisioError("Session visio introuvable.");
  if (session.statut === "en_cours") {
    throw new VisioError("Impossible de supprimer une visite en cours.");
  }

  for (const capture of session.captures) {
    try {
      await fs.unlink(cheminCaptureVisio(capture.fichierNom));
    } catch {
      // Fichier deja absent du disque : on continue quand meme la suppression en base.
    }
  }
  await prisma.captureVisio.deleteMany({ where: { sessionId: id } });
  return prisma.sessionVisio.delete({ where: { id } });
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
    #btn-rejoindre[hidden], #controles[hidden], #video-locale[hidden], #consentement[hidden] { display:none; }
    button { font-size:15px; padding:12px 20px; border-radius:10px; border:none; background:#3D6BFF; color:#fff; }
    button:disabled { opacity:0.6; }
    button#btn-raccrocher { background:#D64545; }
    #consentement { max-width:420px; width:100%; background:rgba(255,255,255,0.06); border-radius:12px; padding:18px; box-sizing:border-box; }
    #consentement h2 { margin:0 0 10px; font-size:16px; }
    .case-consentement { display:flex; align-items:flex-start; gap:10px; margin-bottom:12px; font-size:13px; line-height:1.4; }
    .case-consentement input { margin-top:3px; flex:none; width:18px; height:18px; }
    .case-consentement a { color:#8FB2FF; }
    .texte-legal { font-size:12px; line-height:1.5; color:#C7D1E8; background:rgba(0,0,0,0.2); border-radius:8px; padding:10px; margin:6px 0 10px; }
    .texte-legal[hidden] { display:none; }
  </style>
</head>
<body>
  <div id="consentement">
    <h2>Avant de continuer</h2>
    <label class="case-consentement">
      <input type="checkbox" id="case-cgu" />
      <span>J'accepte les <a href="#" id="lien-cgu">conditions générales</a> et la <a href="#" id="lien-charte">charte de confidentialité</a>.</span>
    </label>
    <p class="texte-legal" id="texte-cgu" hidden>Conditions générales (modèle standard) : ce service de visio est fourni par Atelier Brochant dans le cadre de la préparation d'un devis à distance. L'accès est strictement réservé à la personne ayant reçu ce lien. Toute utilisation frauduleuse ou détournée engage la responsabilité de son auteur.</p>
    <p class="texte-legal" id="texte-charte" hidden>Charte de confidentialité (modèle standard) : vos données personnelles (nom, téléphone, images captées pendant l'échange) sont traitées par Atelier Brochant conformément au RGPD, uniquement pour la préparation de votre devis. Elles ne sont jamais transmises à un tiers sans votre accord et sont conservées le temps nécessaire au traitement de votre demande. Vous disposez d'un droit d'accès, de rectification et de suppression en contactant Atelier Brochant.</p>
    <label class="case-consentement">
      <input type="checkbox" id="case-camera" />
      <span>Je consens à l'activation de ma caméra et de mon micro pour cet échange.</span>
    </label>
    <label class="case-consentement">
      <input type="checkbox" id="case-photos" />
      <span>Je consens à la prise de captures d'écran pendant la visio, utilisées pour la préparation de mon devis.</span>
    </label>
  </div>
  <div id="etat">Acceptez les 3 conditions ci-dessus pour accéder à la visio.</div>
  <video id="video-locale" autoplay playsinline muted hidden></video>
  <button type="button" id="btn-rejoindre" disabled>J'accède à la visio</button>
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
      var consentement = document.getElementById("consentement");
      var btnRejoindre = document.getElementById("btn-rejoindre");
      var btnMicro = document.getElementById("btn-micro");
      var btnRaccrocher = document.getElementById("btn-raccrocher");
      var caseCgu = document.getElementById("case-cgu");
      var caseCamera = document.getElementById("case-camera");
      var casePhotos = document.getElementById("case-photos");
      var room = null;
      var fluxLocal = null;

      function majBoutonConsentement() {
        var toutCoche = caseCgu.checked && caseCamera.checked && casePhotos.checked;
        btnRejoindre.disabled = !toutCoche;
        if (toutCoche) etat.textContent = "Appuyez pour accéder à la visio.";
      }
      [caseCgu, caseCamera, casePhotos].forEach(function (c) {
        c.addEventListener("change", majBoutonConsentement);
      });

      function toggleTexteLegal(lienId, texteId) {
        document.getElementById(lienId).addEventListener("click", function (e) {
          e.preventDefault();
          var el = document.getElementById(texteId);
          el.hidden = !el.hidden;
        });
      }
      toggleTexteLegal("lien-cgu", "texte-cgu");
      toggleTexteLegal("lien-charte", "texte-charte");

      // Safari iOS (et la plupart des navigateurs mobiles) n'accorde la
      // camera/le micro que si getUserMedia est appele en reaction directe
      // a un geste de l'utilisateur (un tap) - un appel automatique au
      // chargement de la page echoue silencieusement, sans la moindre
      // invite de permission (constate en conditions reelles : "Caméra/
      // micro refusés ou indisponibles" systematique sur iPhone malgre un
      // appareil fonctionnel). D'ou le bouton "Rejoindre l'appel" : la
      // demande de camera/micro est la toute premiere chose faite dans son
      // gestionnaire de clic, avant tout autre traitement asynchrone.
      btnRejoindre.addEventListener("click", async function () {
        btnRejoindre.disabled = true;
        etat.textContent = "Connexion en cours…";

        try {
          fluxLocal = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (e) {
          etat.textContent = "Caméra/micro refusés ou indisponibles : autorisez-les puis rechargez la page.";
          btnRejoindre.disabled = false;
          return;
        }
        videoLocale.srcObject = fluxLocal;
        videoLocale.hidden = false;
        consentement.hidden = true;

        var reponse;
        try {
          reponse = await fetch("/visio-client/" + token + "/jeton", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              consentAccepte: caseCgu.checked,
              consentCameraMicro: caseCamera.checked,
              consentPhotos: casePhotos.checked,
            }),
          });
        } catch (e) {
          etat.textContent = "Connexion impossible (réseau).";
          btnRejoindre.disabled = false;
          consentement.hidden = false;
          return;
        }
        if (!reponse.ok) {
          etat.textContent = "Lien invalide ou appel déjà terminé.";
          btnRejoindre.disabled = false;
          consentement.hidden = false;
          return;
        }
        var donnees = await reponse.json();
        room = new LivekitClient.Room();
        try {
          await room.connect(donnees.livekitUrl, donnees.jetonClient);
          // "source" explicite obligatoire : sans lui, publishTrack() d'une
          // MediaStreamTrack brute (contrairement a une piste creee via
          // setCameraEnabled) publie une source "unknown" - rejetee par
          // LiveKit ("insufficient permissions") puisque le jeton client
          // restreint volontairement canPublishSources a camera/microphone.
          await room.localParticipant.publishTrack(fluxLocal.getVideoTracks()[0], { source: LivekitClient.Track.Source.Camera });
          await room.localParticipant.publishTrack(fluxLocal.getAudioTracks()[0], { source: LivekitClient.Track.Source.Microphone });
        } catch (e) {
          etat.textContent = "Connexion impossible. Réessayez.";
          btnRejoindre.disabled = false;
          return;
        }

        etat.textContent = "Vous êtes en relation avec Atelier Brochant.";
        btnRejoindre.hidden = true;
        controles.hidden = false;
      });

      btnMicro.addEventListener("click", function () {
        if (!fluxLocal) return;
        var piste = fluxLocal.getAudioTracks()[0];
        piste.enabled = !piste.enabled;
        btnMicro.textContent = piste.enabled ? "Couper le micro" : "Activer le micro";
      });

      btnRaccrocher.addEventListener("click", function () {
        if (room) room.disconnect();
        if (fluxLocal) fluxLocal.getTracks().forEach(function (t) { t.stop(); });
        etat.textContent = "Appel terminé. Vous pouvez fermer cette page.";
        controles.hidden = true;
        videoLocale.hidden = true;
      });
    })();
  </script>
</body>
</html>`;
}
