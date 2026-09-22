import Link from "next/link";
import { siteConfig } from "@/lib/site-config";
import { PhoneLink } from "./phone-link";

export function SiteFooter() {
  return (
    <footer className="border-t border-black/10 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="grid gap-8 sm:grid-cols-3">
          <div>
            <p className="font-semibold text-ink">{siteConfig.brand}</p>
            <p className="mt-2 text-sm text-ink/60">
              Mise en relation avec des solutions de rénovation énergétique
              adaptées à votre logement.
            </p>
          </div>
          <div>
            <p className="font-semibold text-ink">Nous contacter</p>
            <p className="mt-2 text-sm text-ink/60">
              <PhoneLink className="font-semibold text-primary hover:underline" />
            </p>
          </div>
          <div>
            <p className="font-semibold text-ink">Informations légales</p>
            <ul className="mt-2 space-y-1 text-sm text-ink/60">
              <li>
                <Link href="/mentions-legales" className="hover:underline">
                  Mentions légales
                </Link>
              </li>
              <li>
                <Link href="/politique-confidentialite" className="hover:underline">
                  Politique de confidentialité
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <p className="mt-8 text-xs leading-relaxed text-ink/50">
          {siteConfig.brand} met en relation des particuliers avec des
          professionnels de la rénovation énergétique. Les aides publiques
          citées sur ce site (MaPrimeRénov&apos;, CEE, éco-PTZ...) sont
          soumises à conditions d&apos;éligibilité et évaluées au cas par cas
          après étude de votre dossier : elles ne sont ni automatiques, ni
          garanties avant cette étude.
        </p>
      </div>
    </footer>
  );
}
