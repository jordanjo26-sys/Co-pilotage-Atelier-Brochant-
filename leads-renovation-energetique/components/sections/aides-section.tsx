const AIDES = [
  {
    nom: "MaPrimeRénov'",
    description: "Aide de l'État calculée selon vos revenus et le gain énergétique des travaux.",
  },
  {
    nom: "Certificats d'Économies d'Énergie (CEE)",
    description: "Prime versée par les fournisseurs d'énergie pour certains travaux éligibles.",
  },
  {
    nom: "Éco-prêt à taux zéro",
    description: "Un financement sans intérêt pour compléter votre plan de financement.",
  },
];

export function AidesSection() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <h2 className="text-2xl font-bold text-ink sm:text-3xl">Les aides à la rénovation</h2>
      <p className="mt-2 max-w-2xl text-ink/70">
        Selon votre situation et vos travaux, votre projet peut être éligible
        à un ou plusieurs dispositifs d&apos;aide publique.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {AIDES.map((aide) => (
          <div key={aide.nom} className="rounded-2xl border border-black/10 bg-white p-5">
            <h3 className="font-semibold text-ink">{aide.nom}</h3>
            <p className="mt-1 text-sm text-ink/60">{aide.description}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-2xl border border-accent/40 bg-accent/10 p-5 text-sm text-ink/80">
        <p className="font-semibold text-ink">À savoir avant de vous engager</p>
        <p className="mt-1">
          Ces aides sont soumises à des conditions d&apos;éligibilité (revenus,
          type de logement, performance des travaux...) et ne sont ni
          automatiques ni garanties avant l&apos;étude complète de votre
          dossier. Le montant exact ne peut être déterminé qu&apos;après
          analyse de votre situation par un conseiller — nous ne promettons
          jamais de travaux gratuits ni un financement à 100 % avant cette
          étude.
        </p>
      </div>
    </section>
  );
}
