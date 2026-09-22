import Link from "next/link";
import { PhoneLink } from "../phone-link";
import { HouseIllustration } from "./house-illustration";

export function Hero({
  title,
  subtitle,
  bullets,
}: {
  title: string;
  subtitle: string;
  bullets: string[];
}) {
  return (
    <section className="bg-gradient-to-b from-primary-light to-paper">
      <div className="mx-auto grid max-w-6xl items-center gap-8 px-4 py-10 sm:px-6 sm:py-16 lg:grid-cols-2 lg:py-20">
        <div>
          <h1 className="text-3xl font-bold leading-tight text-ink sm:text-4xl lg:text-[2.75rem]">
            {title}
          </h1>
          <p className="mt-4 text-lg text-ink/70">{subtitle}</p>

          <ul className="mt-5 space-y-2">
            {bullets.map((bullet) => (
              <li key={bullet} className="flex items-start gap-2 text-ink/80">
                <CheckIcon />
                <span>{bullet}</span>
              </li>
            ))}
          </ul>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <Link href="#etude" className="btn btn-accent">
              Vérifier mon projet
            </Link>
            <a href="#etude" className="btn btn-outline sm:hidden">
              Être rappelé gratuitement
            </a>
            <PhoneLink className="hidden items-center justify-center text-base font-semibold text-primary sm:flex" />
          </div>

          <p className="mt-3 text-xs text-ink/50">
            Étude gratuite et sans engagement. Réponse sous 48h ouvrées.
          </p>
        </div>

        <div className="mx-auto w-full max-w-md lg:max-w-none">
          <HouseIllustration />
        </div>
      </div>
    </section>
  );
}

function CheckIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      className="mt-0.5 shrink-0 text-primary"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.15" />
      <path
        d="M8 12.5l2.5 2.5L16 9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
