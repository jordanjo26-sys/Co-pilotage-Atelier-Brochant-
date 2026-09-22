import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { leadSchema } from "@/lib/lead-schema";
import { saveLead } from "@/lib/db";
import { sendMetaLeadEvent } from "@/lib/meta-capi";

// Transmet le lead à un CRM externe si configuré (webhook générique :
// Zapier, Make, HubSpot, Pipedrive... acceptent tous une URL de ce type).
// Ne bloque jamais la réponse au prospect si le CRM est indisponible.
async function forwardToCrm(lead: Record<string, unknown>) {
  const webhookUrl = process.env.CRM_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Échec silencieux côté CRM : le lead reste dans la base locale
    // (voir /api/leads GET, réservé à un usage interne) et pourra être
    // resynchronisé manuellement.
  }
}

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête invalide" }, { status: 400 });
  }

  const result = leadSchema.safeParse(payload);
  if (!result.success) {
    return NextResponse.json(
      { error: "Formulaire invalide", details: result.error.flatten() },
      { status: 400 }
    );
  }

  // Champ honeypot rempli => probablement un bot ; on répond succès sans
  // rien enregistrer, pour ne pas révéler la mesure anti-spam.
  if (result.data.siteWeb) {
    return NextResponse.json({ ok: true });
  }

  const lead = saveLead(result.data);
  const eventId = randomUUID();

  await forwardToCrm({ ...lead, eventId });

  const forwardedFor = request.headers.get("x-forwarded-for");
  await sendMetaLeadEvent({
    eventId,
    email: lead.email,
    telephone: lead.telephone,
    clientIp: forwardedFor?.split(",")[0]?.trim(),
    userAgent: request.headers.get("user-agent") ?? undefined,
    fbc: request.cookies.get("_fbc")?.value,
    fbp: request.cookies.get("_fbp")?.value,
    sourceUrl: request.headers.get("referer") ?? "",
  });

  return NextResponse.json({ ok: true, eventId });
}
