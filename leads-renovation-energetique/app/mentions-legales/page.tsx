import type { Metadata } from "next";
import { siteConfig } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "Mentions légales",
};

export default function MentionsLegalesPage() {
  return (
    <section className="mx-auto max-w-3xl px-4 py-14 text-ink/80 sm:px-6">
      <h1 className="text-2xl font-bold text-ink sm:text-3xl">Mentions légales</h1>

      <p className="mt-6 rounded-2xl border border-accent/40 bg-accent/10 p-4 text-sm">
        Page à compléter avec vos informations réelles avant mise en ligne
        (raison sociale, SIRET, adresse, hébergeur...). Les valeurs
        ci-dessous sont des exemples, définis dans{" "}
        <code>lib/site-config.ts</code>.
      </p>

      <div className="mt-8 space-y-6 text-sm leading-relaxed">
        <div>
          <h2 className="text-lg font-semibold text-ink">Éditeur du site</h2>
          <p className="mt-2">
            {siteConfig.brand}
            <br />
            Siège social : {siteConfig.siegeSocial}
            <br />
            SIRET : {siteConfig.siret}
            <br />
            Directeur de la publication : {siteConfig.directeurPublication}
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-ink">Hébergement</h2>
          <p className="mt-2">
            {siteConfig.hebergeur.nom}
            <br />
            {siteConfig.hebergeur.adresse}
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-ink">Activité</h2>
          <p className="mt-2">
            {siteConfig.brand} met en relation des particuliers avec des
            professionnels de la rénovation énergétique. {siteConfig.brand}{" "}
            n&apos;est pas un organisme public et n&apos;est pas mandaté par
            l&apos;État ; les aides publiques mentionnées sur ce site
            dépendent d&apos;organismes tiers (Agence nationale de
            l&apos;habitat, fournisseurs d&apos;énergie...) et sont attribuées
            selon leurs propres critères d&apos;éligibilité.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-ink">Propriété intellectuelle</h2>
          <p className="mt-2">
            L&apos;ensemble des contenus présents sur ce site (textes,
            visuels, logo) est protégé au titre du droit d&apos;auteur.
            Toute reproduction sans autorisation préalable est interdite.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-ink">Contact</h2>
          <p className="mt-2">
            Pour toute question relative au site, vous pouvez nous contacter
            au {siteConfig.phoneDisplay}.
          </p>
        </div>
      </div>
    </section>
  );
}
