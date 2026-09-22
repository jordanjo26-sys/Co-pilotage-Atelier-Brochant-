import type { Metadata } from "next";
import { siteConfig } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "Politique de confidentialité",
};

export default function PolitiqueConfidentialitePage() {
  return (
    <section className="mx-auto max-w-3xl px-4 py-14 text-ink/80 sm:px-6">
      <h1 className="text-2xl font-bold text-ink sm:text-3xl">
        Politique de confidentialité
      </h1>

      <p className="mt-6 rounded-2xl border border-accent/40 bg-accent/10 p-4 text-sm">
        Page à faire relire par un professionnel du droit avant mise en ligne
        — ce texte couvre les points essentiels mais ne remplace pas un avis
        juridique adapté à votre activité réelle.
      </p>

      <div className="mt-8 space-y-6 text-sm leading-relaxed">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            Quelles données collectons-nous ?
          </h2>
          <p className="mt-2">
            Lorsque vous remplissez notre formulaire de demande d&apos;étude,
            nous collectons : votre prénom, nom, téléphone, e-mail, code
            postal, type de logement, statut d&apos;occupation, travaux
            envisagés, surface approximative et délai souhaité. Nous
            enregistrons également l&apos;origine publicitaire de votre visite
            (campagne, support) afin de mesurer l&apos;efficacité de nos
            actions marketing.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-ink">
            Pourquoi collectons-nous ces données ?
          </h2>
          <p className="mt-2">
            Ces informations nous permettent d&apos;étudier votre projet, de
            vous mettre en relation avec un conseiller puis, le cas échéant,
            avec un professionnel de la rénovation énergétique adapté à votre
            situation. Base légale : votre consentement exprès, donné en
            cochant la case dédiée du formulaire.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-ink">
            Serai-je contacté(e) par téléphone ?
          </h2>
          <p className="mt-2">
            Oui : en soumettant ce formulaire, vous demandez expressément à
            être recontacté(e) par téléphone au sujet de votre projet de
            rénovation énergétique. Cette demande expresse et préalable de
            votre part est la condition légale qui nous autorise à vous
            appeler à ce sujet.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-ink">
            Qui a accès à vos données ?
          </h2>
          <p className="mt-2">
            Vos données sont accessibles à nos équipes internes et,
            uniquement après votre accord, transmises aux professionnels
            partenaires susceptibles de réaliser une étude ou un devis pour
            votre projet. Nous ne vendons jamais vos données à des tiers non
            liés à votre demande.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-ink">
            Combien de temps conservons-nous vos données ?
          </h2>
          <p className="mt-2">
            Vos données sont conservées pendant la durée nécessaire au
            traitement de votre demande, puis jusqu&apos;à 3 ans à compter du
            dernier contact si vous ne donnez pas suite, à des fins de
            prospection commerciale, sauf opposition de votre part.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-ink">Vos droits</h2>
          <p className="mt-2">
            Conformément au Règlement Général sur la Protection des Données,
            vous disposez d&apos;un droit d&apos;accès, de rectification,
            d&apos;effacement et d&apos;opposition sur vos données. Pour
            exercer ces droits, contactez-nous au {siteConfig.phoneDisplay}.
            Vous pouvez également introduire une réclamation auprès de la
            CNIL (cnil.fr).
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-ink">Cookies</h2>
          <p className="mt-2">
            Ce site utilise des cookies de mesure d&apos;audience (Google
            Analytics) et publicitaires (Google Ads, Meta) afin de mesurer
            l&apos;efficacité de nos campagnes. Ces cookies ne sont déposés
            qu&apos;après votre consentement, donné via le bandeau affiché en
            bas de page. Vous pouvez à tout moment modifier votre choix en
            effaçant les cookies de votre navigateur.
          </p>
        </div>
      </div>
    </section>
  );
}
