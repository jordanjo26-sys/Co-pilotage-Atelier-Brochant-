"use client";

import { useEffect } from "react";
import { trackingConfig } from "@/lib/site-config";

// Déclenche les événements de conversion sur la page de confirmation.
// N'a d'effet que si les scripts correspondants ont été chargés (donc si le
// consentement a été donné) — voir components/analytics.tsx.
export function ConversionTracking() {
  useEffect(() => {
    if (window.gtag) {
      window.gtag("event", "generate_lead");
      if (trackingConfig.googleAdsConversionId && trackingConfig.googleAdsConversionLabel) {
        window.gtag("event", "conversion", {
          send_to: `${trackingConfig.googleAdsConversionId}/${trackingConfig.googleAdsConversionLabel}`,
        });
      }
    }
    if (window.fbq) {
      window.fbq("track", "Lead");
    }
  }, []);

  return null;
}
