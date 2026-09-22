import { siteConfig } from "@/lib/site-config";

export function PhoneLink({ className = "" }: { className?: string }) {
  return (
    <a
      href={`tel:${siteConfig.phoneHref}`}
      className={className}
      aria-label={`Appeler le ${siteConfig.phoneDisplay}`}
    >
      {siteConfig.phoneDisplay}
    </a>
  );
}
