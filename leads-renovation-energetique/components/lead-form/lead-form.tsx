"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  TYPES_LOGEMENT,
  STATUTS_OCCUPANT,
  TRAVAUX,
  SURFACES,
  DELAIS,
  type TravauxValue,
} from "@/lib/lead-options";
import { getTrackingParams } from "@/lib/utm";
import { siteConfig } from "@/lib/site-config";
import { OptionCard } from "./option-card";
import { ProgressBar } from "./progress-bar";

type StepKey =
  | "typeLogement"
  | "statutOccupant"
  | "travaux"
  | "surface"
  | "codePostal"
  | "delaiTravaux"
  | "contact";

interface FormData {
  typeLogement: string;
  statutOccupant: string;
  travaux: string;
  surface: string;
  codePostal: string;
  delaiTravaux: string;
  prenom: string;
  nom: string;
  telephone: string;
  email: string;
  consentement: boolean;
}

const TELEPHONE_REGEX = /^(?:\+33|0)[1-9](?:[ .-]?[0-9]{2}){4}$/;
const CODE_POSTAL_REGEX = /^[0-9]{5}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LeadForm({ defaultTravaux }: { defaultTravaux?: TravauxValue }) {
  const router = useRouter();

  const steps = useMemo<StepKey[]>(() => {
    const all: StepKey[] = [
      "typeLogement",
      "statutOccupant",
      "travaux",
      "surface",
      "codePostal",
      "delaiTravaux",
      "contact",
    ];
    return defaultTravaux ? all.filter((s) => s !== "travaux") : all;
  }, [defaultTravaux]);

  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [data, setData] = useState<FormData>({
    typeLogement: "",
    statutOccupant: "",
    travaux: defaultTravaux ?? "",
    surface: "",
    codePostal: "",
    delaiTravaux: "",
    prenom: "",
    nom: "",
    telephone: "",
    email: "",
    consentement: false,
  });
  // Champ piège anti-spam : un vrai visiteur ne le voit ni ne le remplit.
  const [honeypot, setHoneypot] = useState("");

  const currentKey = steps[stepIndex];
  const isLastStep = stepIndex === steps.length - 1;

  function update<K extends keyof FormData>(key: K, value: FormData[K]) {
    setData((prev) => ({ ...prev, [key]: value }));
    setError(null);
  }

  function validateCurrentStep(): boolean {
    switch (currentKey) {
      case "typeLogement":
        if (!data.typeLogement) return fail("Merci de sélectionner une option.");
        return true;
      case "statutOccupant":
        if (!data.statutOccupant) return fail("Merci de sélectionner une option.");
        return true;
      case "travaux":
        if (!data.travaux) return fail("Merci de sélectionner une option.");
        return true;
      case "surface":
        if (!data.surface) return fail("Merci de sélectionner une option.");
        return true;
      case "codePostal":
        if (!CODE_POSTAL_REGEX.test(data.codePostal.trim()))
          return fail("Merci de saisir un code postal valide (5 chiffres).");
        return true;
      case "delaiTravaux":
        if (!data.delaiTravaux) return fail("Merci de sélectionner une option.");
        return true;
      case "contact": {
        if (!data.prenom.trim() || !data.nom.trim())
          return fail("Merci de renseigner votre prénom et votre nom.");
        if (!TELEPHONE_REGEX.test(data.telephone.trim()))
          return fail("Merci de saisir un numéro de téléphone valide.");
        if (!EMAIL_REGEX.test(data.email.trim()))
          return fail("Merci de saisir une adresse e-mail valide.");
        if (!data.consentement)
          return fail("Merci d'accepter d'être contacté pour envoyer votre demande.");
        return true;
      }
      default:
        return true;
    }
  }

  function fail(message: string): false {
    setError(message);
    return false;
  }

  function goNext() {
    if (!validateCurrentStep()) return;
    if (isLastStep) {
      void submit();
      return;
    }
    setStepIndex((i) => i + 1);
  }

  function goBack() {
    setError(null);
    setStepIndex((i) => Math.max(0, i - 1));
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);

    const tracking = getTrackingParams();

    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          siteWeb: honeypot,
          ...tracking,
        }),
      });

      if (!response.ok) {
        throw new Error("Échec de l'envoi");
      }

      router.push("/merci");
    } catch {
      setSubmitError(
        "Une erreur est survenue lors de l'envoi. Merci de réessayer, ou de nous appeler directement."
      );
      setSubmitting(false);
    }
  }

  return (
    <div
      id="etude"
      className="scroll-mt-20 rounded-3xl border border-black/5 bg-white p-5 shadow-sm sm:p-8"
    >
      <ProgressBar step={stepIndex} total={steps.length} />

      {/* Honeypot : caché visuellement et des lecteurs d'écran, jamais rempli par un humain. */}
      <input
        type="text"
        name="siteWeb"
        value={honeypot}
        onChange={(e) => setHoneypot(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute -left-[9999px] h-0 w-0 opacity-0"
      />

      {currentKey === "typeLogement" && (
        <StepChoice
          title="Quel type de logement souhaitez-vous rénover ?"
          options={TYPES_LOGEMENT}
          value={data.typeLogement}
          onChange={(v) => update("typeLogement", v)}
        />
      )}

      {currentKey === "statutOccupant" && (
        <StepChoice
          title="Êtes-vous propriétaire ?"
          options={STATUTS_OCCUPANT}
          value={data.statutOccupant}
          onChange={(v) => update("statutOccupant", v)}
        />
      )}

      {currentKey === "travaux" && (
        <StepChoice
          title="Quels travaux envisagez-vous ?"
          options={TRAVAUX}
          value={data.travaux}
          onChange={(v) => update("travaux", v)}
        />
      )}

      {currentKey === "surface" && (
        <StepChoice
          title="Quelle est approximativement la surface du logement ?"
          options={SURFACES}
          value={data.surface}
          onChange={(v) => update("surface", v)}
        />
      )}

      {currentKey === "codePostal" && (
        <div>
          <h3 className="mb-4 text-xl font-semibold text-ink">
            Quel est votre code postal ?
          </h3>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={5}
            placeholder="Ex. 75012"
            value={data.codePostal}
            onChange={(e) => update("codePostal", e.target.value.replace(/[^0-9]/g, ""))}
            className="w-full rounded-2xl border-2 border-black/10 px-5 py-4 text-lg focus:border-primary focus:outline-none"
          />
        </div>
      )}

      {currentKey === "delaiTravaux" && (
        <StepChoice
          title="Quand souhaitez-vous réaliser les travaux ?"
          options={DELAIS}
          value={data.delaiTravaux}
          onChange={(v) => update("delaiTravaux", v)}
        />
      )}

      {currentKey === "contact" && (
        <div>
          <h3 className="mb-1 text-xl font-semibold text-ink">
            Dernière étape : vos coordonnées
          </h3>
          <p className="mb-4 text-sm text-ink/60">
            Un conseiller vous recontacte pour étudier votre projet.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              type="text"
              placeholder="Prénom"
              autoComplete="given-name"
              value={data.prenom}
              onChange={(e) => update("prenom", e.target.value)}
              className="rounded-2xl border-2 border-black/10 px-5 py-4 text-base focus:border-primary focus:outline-none"
            />
            <input
              type="text"
              placeholder="Nom"
              autoComplete="family-name"
              value={data.nom}
              onChange={(e) => update("nom", e.target.value)}
              className="rounded-2xl border-2 border-black/10 px-5 py-4 text-base focus:border-primary focus:outline-none"
            />
          </div>
          <input
            type="tel"
            placeholder="Téléphone"
            autoComplete="tel"
            value={data.telephone}
            onChange={(e) => update("telephone", e.target.value)}
            className="mt-3 w-full rounded-2xl border-2 border-black/10 px-5 py-4 text-base focus:border-primary focus:outline-none"
          />
          <input
            type="email"
            placeholder="E-mail"
            autoComplete="email"
            value={data.email}
            onChange={(e) => update("email", e.target.value)}
            className="mt-3 w-full rounded-2xl border-2 border-black/10 px-5 py-4 text-base focus:border-primary focus:outline-none"
          />

          <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm text-ink/70">
            <input
              type="checkbox"
              checked={data.consentement}
              onChange={(e) => update("consentement", e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-primary)]"
            />
            <span>
              J&apos;accepte d&apos;être contacté(e) par téléphone et e-mail par{" "}
              {siteConfig.brand} et ses partenaires professionnels pour étudier
              mon projet de rénovation énergétique. Voir notre{" "}
              <a href="/politique-confidentialite" target="_blank" className="underline">
                politique de confidentialité
              </a>
              .
            </span>
          </label>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm font-medium text-red-600">
          {error}
        </p>
      )}
      {submitError && (
        <p role="alert" className="mt-4 text-sm font-medium text-red-600">
          {submitError}
        </p>
      )}

      <div className="mt-6 flex items-center gap-3">
        {stepIndex > 0 && (
          <button
            type="button"
            onClick={goBack}
            disabled={submitting}
            className="btn btn-outline !px-5"
          >
            Précédent
          </button>
        )}
        <button
          type="button"
          onClick={goNext}
          disabled={submitting}
          className="btn btn-accent flex-1 disabled:opacity-60"
        >
          {submitting ? "Envoi en cours..." : isLastStep ? "Envoyer ma demande" : "Suivant"}
        </button>
      </div>
    </div>
  );
}

function StepChoice({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <h3 className="mb-4 text-xl font-semibold text-ink">{title}</h3>
      <div className="grid gap-3">
        {options.map((option) => (
          <OptionCard
            key={option.value}
            label={option.label}
            selected={value === option.value}
            onClick={() => onChange(option.value)}
          />
        ))}
      </div>
    </div>
  );
}
