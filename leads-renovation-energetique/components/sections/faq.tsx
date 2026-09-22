const QUESTIONS = [
  {
    q: "L'étude de mon projet est-elle vraiment gratuite ?",
    a: "Oui, l'étude de votre projet et de votre éligibilité aux aides est gratuite et sans engagement.",
  },
  {
    q: "Quelles aides puis-je obtenir ?",
    a: "Cela dépend de vos revenus, de votre logement et des travaux envisagés. Un conseiller évalue précisément votre éligibilité après étude de votre dossier — aucun montant n'est garanti à l'avance.",
  },
  {
    q: "Suis-je obligé(e) de faire les travaux après l'étude ?",
    a: "Non. L'étude et la mise en relation avec un professionnel ne vous engagent à rien.",
  },
  {
    q: "Sous combien de temps serai-je recontacté(e) ?",
    a: "Un conseiller vous contacte sous 48h ouvrées après l'envoi de votre demande.",
  },
  {
    q: "Que faites-vous de mes données personnelles ?",
    a: "Vos données servent uniquement à étudier votre projet et à vous mettre en relation avec un professionnel adapté. Voir notre politique de confidentialité pour le détail.",
  },
];

export function Faq() {
  return (
    <section className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h2 className="text-2xl font-bold text-ink sm:text-3xl">Questions fréquentes</h2>

      <div className="mt-6 space-y-3">
        {QUESTIONS.map((item) => (
          <details
            key={item.q}
            className="group rounded-2xl border border-black/10 bg-white p-5 [&_summary::-webkit-details-marker]:hidden"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-ink">
              {item.q}
              <span className="shrink-0 text-primary transition-transform group-open:rotate-45">
                +
              </span>
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-ink/70">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
