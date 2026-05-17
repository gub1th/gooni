import { useEffect, useState } from "react";

// Fetches the visitor's country code on mount via api.country.is
// (free, CORS-enabled, no key). Converts the 2-letter code to a flag
// emoji using regional-indicator codepoints. Returns null until
// resolved; failures stay null and never throw.

function countryCodeToFlag(code: string): string {
  return code
    .toUpperCase()
    .replace(/[A-Z]/g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

export function useCountryFlag(): string | null {
  const [flag, setFlag] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    fetch("https://api.country.is/")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { country?: string } | null) => {
        if (aborted || !d?.country) return;
        setFlag(countryCodeToFlag(d.country));
      })
      .catch(() => { /* swallow — flag stays null */ });
    return () => {
      aborted = true;
    };
  }, []);

  return flag;
}
