"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import {
  subscribeConsent,
  getConsentSnapshot,
  getConsentServerSnapshot,
  setConsent,
} from "@/lib/consent";

// Bandeau de consentement minimal : rien n'est chargé (GA4, Meta Pixel,
// conversion Google Ads) tant que l'utilisateur n'a pas fait un choix, et
// refuser est aussi simple qu'accepter (recommandation CNIL).
export function CookieConsent() {
  const consent = useSyncExternalStore(
    subscribeConsent,
    getConsentSnapshot,
    getConsentServerSnapshot
  );

  if (consent !== null) return null;

  function choose(analytics: boolean, marketing: boolean) {
    setConsent({ analytics, marketing });
  }

  return (
    <div
      role="dialog"
      aria-label="Gestion des cookies"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-black/10 bg-white p-4 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] sm:p-5"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-ink/70">
          Nous utilisons des cookies de mesure d&apos;audience et publicitaires
          pour améliorer nos campagnes et votre expérience. Vous pouvez
          accepter ou refuser librement.{" "}
          <Link href="/politique-confidentialite" className="underline">
            En savoir plus
          </Link>
          .
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => choose(false, false)}
            className="btn btn-outline !min-h-0 !px-4 !py-2 text-sm"
          >
            Refuser
          </button>
          <button
            type="button"
            onClick={() => choose(true, true)}
            className="btn btn-accent !min-h-0 !px-4 !py-2 text-sm"
          >
            Accepter
          </button>
        </div>
      </div>
    </div>
  );
}
