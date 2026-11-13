import { useEffect, useState } from "react";

/** A temporary object URL for bytes, revoked when they change or the component unmounts. */
export const useObjectUrl = (bytes: Uint8Array | undefined, mimeType: string): string | null => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: mimeType || "application/octet-stream" }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes, mimeType]);
  return url;
};
