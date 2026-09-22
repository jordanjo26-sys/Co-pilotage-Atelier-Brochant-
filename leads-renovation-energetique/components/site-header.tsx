import Link from "next/link";
import { siteConfig } from "@/lib/site-config";
import { PhoneLink } from "./phone-link";

// En-tête volontairement minimal : sur une landing page publicitaire, chaque
// lien qui n'est pas le téléphone ou le CTA est une sortie de parcours.
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-black/5 bg-paper/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-white">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 2 3 9v12h6v-7h6v7h6V9l-9-7Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
                fill="none"
              />
              <path
                d="M12 6.5 9 9v3h6V9l-3-2.5Z"
                fill="currentColor"
              />
            </svg>
          </span>
          <span className="font-semibold text-ink leading-tight">
            {siteConfig.brand}
            <span className="block text-xs font-normal text-ink/60">
              {siteConfig.baseline}
            </span>
          </span>
        </Link>

        <div className="flex items-center gap-2 sm:gap-4">
          <PhoneLink className="hidden sm:inline text-sm font-semibold text-primary underline-offset-4 hover:underline" />
          <Link href="#etude" className="btn btn-accent !py-2.5 !px-4 text-sm sm:!px-5">
            Vérifier mon projet
          </Link>
        </div>
      </div>
    </header>
  );
}
