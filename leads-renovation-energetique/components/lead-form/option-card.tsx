"use client";

export function OptionCard({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`w-full rounded-2xl border-2 px-5 py-4 text-left text-base font-medium transition-colors min-h-[3.25rem] ${
        selected
          ? "border-primary bg-primary-light text-primary-dark"
          : "border-black/10 bg-white text-ink hover:border-primary/40"
      }`}
    >
      <span className="flex items-center justify-between gap-3">
        {label}
        <span
          aria-hidden="true"
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
            selected ? "border-primary bg-primary" : "border-black/20"
          }`}
        >
          {selected && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
              <path
                d="M5 13l4 4L19 7"
                stroke="white"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      </span>
    </button>
  );
}
