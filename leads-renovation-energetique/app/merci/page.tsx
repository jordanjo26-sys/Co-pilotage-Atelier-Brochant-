import type { Metadata } from "next";
import Link from "next/link";
import { ConversionTracking } from "@/components/conversion-tracking";
import { PhoneLink } from "@/components/phone-link";

export const metadata: Metadata = {
  title: "Votre demande a bien été enregistrée",
  robots: { index: false, follow: false },
};

export default function MerciPage() {
  return (
    <section className="mx-auto flex max-w-xl flex-col items-center px-4 py-20 text-center sm:px-6">
      <ConversionTracking />

      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-light text-primary">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M5 13l4 4L19 7"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>

      <h1 className="mt-6 text-2xl font-bold text-ink sm:text-3xl">
        Votre demande a bien été enregistrée
      </h1>
      <p className="mt-3 text-ink/70">
        Un conseiller vous contactera afin d&apos;étudier votre projet et les
        solutions pouvant correspondre à votre situation.
      </p>

      <p className="mt-6 text-sm text-ink/60">
        Une question en attendant ? Appelez-nous directement au{" "}
        <PhoneLink className="font-semibold text-primary hover:underline" />
      </p>

      <Link href="/" className="btn btn-outline mt-8">
        Retour à l&apos;accueil
      </Link>
    </section>
  );
}
