import { useEffect, useState } from "react";

const SVG = "image/svg+xml";

/**
 * A URL for bytes, made again when they change and revoked when the component unmounts. An SVG
 * gets a data URL rather than an object URL: an `<img>` never runs its script, but opened on its
 * own (say in a new tab) an object URL would run it as the Workshop, and a data URL has no origin.
 */
export const useObjectUrl = (bytes: Uint8Array | undefined, mimeType: string): string | null => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) {
      setUrl(null);
      return;
    }
    const blob = new Blob([bytes as BlobPart], { type: mimeType || "application/octet-stream" });
    if (mimeType.toLowerCase() === SVG) {
      setUrl(null);
      const reader = new FileReader();
      reader.addEventListener("load", () => setUrl(typeof reader.result === "string" ? reader.result : null));
      reader.readAsDataURL(blob);
      return () => reader.abort();
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes, mimeType]);
  return url;
};
