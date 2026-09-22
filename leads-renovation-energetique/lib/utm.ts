"use client";

// Capture les paramètres publicitaires à l'arrivée sur le site et les
// conserve en sessionStorage, pour qu'ils survivent à la navigation entre
// la landing page d'entrée et l'envoi du formulaire (même si l'utilisateur
// met plusieurs minutes à le remplir).

export interface TrackingParams {
  source?: string;
  campagne?: string;
  support?: string;
  contenuAnnonce?: string;
  motCle?: string;
  gclid?: string;
  fbclid?: string;
  pageOrigine?: string;
}

const STORAGE_KEY = "rc_tracking_v1";

const PARAM_MAP: Record<keyof TrackingParams, string> = {
  source: "utm_source",
  campagne: "utm_campaign",
  support: "utm_medium",
  contenuAnnonce: "utm_content",
  motCle: "utm_term",
  gclid: "gclid",
  fbclid: "fbclid",
  pageOrigine: "",
};

function inferSource(params: URLSearchParams): string | undefined {
  if (params.get("gclid")) return "google";
  if (params.get("fbclid")) return "facebook";
  if (typeof document !== "undefined" && document.referrer) {
    try {
      return new URL(document.referrer).hostname;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function captureTrackingParams(): void {
  if (typeof window === "undefined") return;

  try {
    const params = new URLSearchParams(window.location.search);
    const hasAnyUtm = Object.values(PARAM_MAP).some((key) => key && params.get(key));

    // On ne réécrit le tracking stocké que si l'URL courante en apporte un
    // nouveau (sinon on garde celui de l'entrée initiale sur le site).
    if (!hasAnyUtm && sessionStorage.getItem(STORAGE_KEY)) return;

    const tracking: TrackingParams = {
      source: params.get("utm_source") ?? inferSource(params),
      campagne: params.get("utm_campaign") ?? undefined,
      support: params.get("utm_medium") ?? undefined,
      contenuAnnonce: params.get("utm_content") ?? undefined,
      motCle: params.get("utm_term") ?? undefined,
      gclid: params.get("gclid") ?? undefined,
      fbclid: params.get("fbclid") ?? undefined,
      pageOrigine: window.location.pathname,
    };

    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tracking));
  } catch {
    // sessionStorage indisponible (navigation privée stricte) : tant pis,
    // le lead sera simplement enregistré sans traçabilité publicitaire.
  }
}

export function getTrackingParams(): TrackingParams {
  if (typeof window === "undefined") return {};
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TrackingParams) : {};
  } catch {
    return {};
  }
}
