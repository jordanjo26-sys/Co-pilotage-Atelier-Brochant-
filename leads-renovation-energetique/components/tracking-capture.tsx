"use client";

import { useEffect } from "react";
import { captureTrackingParams } from "@/lib/utm";

// Composant invisible monté une fois par page (voir layout) pour capter les
// paramètres publicitaires (utm_*, gclid, fbclid) dès l'arrivée sur le site,
// quelle que soit la page d'atterrissage.
export function TrackingCapture() {
  useEffect(() => {
    captureTrackingParams();
  }, []);

  return null;
}
