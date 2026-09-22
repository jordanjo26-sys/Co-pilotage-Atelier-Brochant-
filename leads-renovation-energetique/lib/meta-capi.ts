import { createHash } from "node:crypto";

// Envoi côté serveur à l'API Conversions de Meta (plus fiable que le seul
// pixel navigateur, qui peut être bloqué par un bloqueur de publicités).
// N'envoie rien si les identifiants ne sont pas configurés : le reste du
// site continue de fonctionner normalement (voir README, section tracking).

const sha256 = (value: string) =>
  createHash("sha256").update(value.trim().toLowerCase()).digest("hex");

interface SendLeadEventParams {
  eventId: string; // partagé avec le pixel navigateur pour dédupliquer
  email: string;
  telephone: string;
  clientIp?: string;
  userAgent?: string;
  fbc?: string; // cookie _fbc si transmis par le client
  fbp?: string; // cookie _fbp si transmis par le client
  sourceUrl: string;
}

export async function sendMetaLeadEvent(params: SendLeadEventParams): Promise<void> {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CONVERSIONS_API_TOKEN;
  if (!pixelId || !accessToken) return;

  // Le numéro doit être normalisé (indicatif + chiffres uniquement) avant hachage.
  const digitsOnly = params.telephone.replace(/[^0-9]/g, "");
  const phoneE164 = digitsOnly.startsWith("33")
    ? digitsOnly
    : `33${digitsOnly.replace(/^0/, "")}`;

  const body = {
    data: [
      {
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        event_id: params.eventId,
        event_source_url: params.sourceUrl,
        action_source: "website",
        user_data: {
          em: [sha256(params.email)],
          ph: [sha256(phoneE164)],
          client_ip_address: params.clientIp,
          client_user_agent: params.userAgent,
          fbc: params.fbc,
          fbp: params.fbp,
        },
      },
    ],
  };

  try {
    await fetch(
      `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
  } catch {
    // La remontée CAPI est un bonus de fiabilité, jamais bloquant pour
    // l'enregistrement du lead lui-même.
  }
}
