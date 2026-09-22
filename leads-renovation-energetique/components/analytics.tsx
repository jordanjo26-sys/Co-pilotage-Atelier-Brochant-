"use client";

import { useSyncExternalStore } from "react";
import Script from "next/script";
import { trackingConfig } from "@/lib/site-config";
import {
  subscribeConsent,
  getConsentSnapshot,
  getConsentServerSnapshot,
} from "@/lib/consent";

// N'injecte GA4 / Google Ads / Meta Pixel qu'après consentement explicite,
// et seulement si l'identifiant correspondant est configuré (voir .env.example).
export function Analytics() {
  const consent = useSyncExternalStore(
    subscribeConsent,
    getConsentSnapshot,
    getConsentServerSnapshot
  );

  const allowAnalytics = consent?.analytics ?? false;
  const allowMarketing = consent?.marketing ?? false;

  const showGoogle =
    allowAnalytics &&
    (trackingConfig.ga4MeasurementId || (allowMarketing && trackingConfig.googleAdsConversionId));

  return (
    <>
      {showGoogle && (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${
              trackingConfig.ga4MeasurementId || trackingConfig.googleAdsConversionId
            }`}
            strategy="afterInteractive"
          />
          <Script id="gtag-init" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              window.gtag = gtag;
              gtag('js', new Date());
              gtag('consent', 'default', {
                ad_storage: '${allowMarketing ? "granted" : "denied"}',
                analytics_storage: '${allowAnalytics ? "granted" : "denied"}'
              });
              ${
                trackingConfig.ga4MeasurementId
                  ? `gtag('config', '${trackingConfig.ga4MeasurementId}');`
                  : ""
              }
              ${
                allowMarketing && trackingConfig.googleAdsConversionId
                  ? `gtag('config', '${trackingConfig.googleAdsConversionId}');`
                  : ""
              }
            `}
          </Script>
        </>
      )}

      {allowMarketing && trackingConfig.metaPixelId && (
        <Script id="meta-pixel-init" strategy="afterInteractive">
          {`
            !function(f,b,e,v,n,t,s)
            {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
            n.callMethod.apply(n,arguments):n.queue.push(arguments)};
            if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
            n.queue=[];t=b.createElement(e);t.async=!0;
            t.src=v;s=b.getElementsByTagName(e)[0];
            s.parentNode.insertBefore(t,s)}(window, document,'script',
            'https://connect.facebook.net/en_US/fbevents.js');
            fbq('init', '${trackingConfig.metaPixelId}');
            fbq('track', 'PageView');
          `}
        </Script>
      )}
    </>
  );
}
