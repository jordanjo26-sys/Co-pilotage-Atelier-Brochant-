const STEPS = [
  {
    title: "Vous décrivez votre projet",
    description: "2 minutes suffisent : logement, travaux envisagés et coordonnées.",
  },
  {
    title: "Un conseiller étudie votre situation",
    description: "Analyse de votre logement et des aides auxquelles il peut être éligible.",
  },
  {
    title: "Vous recevez une proposition",
    description: "Un rendez-vous et un devis détaillé, sans engagement de votre part.",
  },
];

export function HowItWorks() {
  return (
    <section className="bg-primary-light/60">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <h2 className="text-2xl font-bold text-ink sm:text-3xl">Comment ça marche</h2>

        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <div key={step.title} className="rounded-2xl bg-white p-6 shadow-sm">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary font-bold text-white">
                {index + 1}
              </span>
              <h3 className="mt-4 text-lg font-semibold text-ink">{step.title}</h3>
              <p className="mt-1 text-sm text-ink/60">{step.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
