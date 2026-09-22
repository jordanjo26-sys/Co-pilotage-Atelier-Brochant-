"use client";

// Gestion minimale du consentement (mesure d'audience + publicité), dans
// l'esprit des recommandations CNIL : refuser doit être aussi simple
// qu'accepter, et rien n'est chargé avant un choix explicite.
//
// Exposé comme un "external store" (voir useSyncExternalStore dans les
// composants qui le consomment) plutôt que via useEffect + setState, pour
// rester synchronisé avec localStorage sans provoquer de rendu en cascade.

export type ConsentChoice = {
  analytics: boolean; // GA4
  marketing: boolean; // Meta Pixel, conversion Google Ads
};

const STORAGE_KEY = "rc_consent_v1";
const CONSENT_EVENT = "rc-consent-changed";

// Cache la dernière valeur lue : useSyncExternalStore exige que getSnapshot
// renvoie une référence stable tant que la donnée sous-jacente n'a pas
// changé (sinon boucle de rendu infinie).
let cachedRaw: string | null | undefined;
let cachedValue: ConsentChoice | null = null;

function readConsent(): ConsentChoice | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }

  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      cachedValue = raw ? (JSON.parse(raw) as ConsentChoice) : null;
    } catch {
      cachedValue = null;
    }
  }

  return cachedValue;
}

export function setConsent(choice: ConsentChoice): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
    window.dispatchEvent(new Event(CONSENT_EVENT));
  } catch {
    // localStorage indisponible : le bandeau se réaffichera à chaque visite,
    // sans bloquer le reste du site.
  }
}

// API pour useSyncExternalStore.
export function subscribeConsent(callback: () => void): () => void {
  window.addEventListener(CONSENT_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CONSENT_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function getConsentSnapshot(): ConsentChoice | null {
  return readConsent();
}

export function getConsentServerSnapshot(): ConsentChoice | null {
  return null;
}
