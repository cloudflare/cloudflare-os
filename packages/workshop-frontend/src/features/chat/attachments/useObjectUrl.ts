import { useEffect, useState } from "react";

const SVG = "image/svg+xml";

interface SharedUrl {
  readonly url: Promise<string>;
  /** Revokes an object URL; a data URL needs nothing. */
  readonly release: () => void;
  users: number;
}

/**
 * The URLs handed out for each array of bytes, by type. A file's readers share one array for a
 * picture it uses many times, and the URL is shared the same way: one Blob, not one per use.
 */
const shared = new WeakMap<Uint8Array, Map<string, SharedUrl>>();

const dataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.addEventListener("load", () => resolve(String(reader.result)));
  reader.addEventListener("error", () => reject(reader.error));
  reader.readAsDataURL(blob);
});

const acquire = (bytes: Uint8Array, mimeType: string): { url: Promise<string>; release: () => void } => {
  const type = mimeType || "application/octet-stream";
  let byType = shared.get(bytes);
  if (!byType) shared.set(bytes, byType = new Map());
  let entry = byType.get(type);
  if (!entry) {
    const blob = new Blob([bytes as BlobPart], { type });
    // Compared without parameters: `image/svg+xml; charset=utf-8` is an SVG too.
    if (type.split(";")[0]!.trim().toLowerCase() === SVG) {
      entry = { url: dataUrl(blob), release: () => {}, users: 0 };
    } else {
      const url = URL.createObjectURL(blob);
      entry = { url: Promise.resolve(url), release: () => URL.revokeObjectURL(url), users: 0 };
    }
    byType.set(type, entry);
  }
  entry.users++;
  const held = entry;
  return {
    url: held.url,
    release: () => {
      if (--held.users > 0) return;
      held.release();
      if (byType.get(type) === held) byType.delete(type);
    },
  };
};

/**
 * A URL for bytes, shared with every other component showing the same bytes as the same type and
 * revoked when the last of them lets go. An SVG gets a data URL rather than an object URL: an
 * `<img>` never runs its script, but opened on its own (say in a new tab) an object URL would run
 * it as the Workshop, and a data URL has no origin.
 */
export const useObjectUrl = (bytes: Uint8Array | undefined, mimeType: string): string | null => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) {
      setUrl(null);
      return;
    }
    let current = true;
    const held = acquire(bytes, mimeType);
    held.url.then((next) => { if (current) setUrl(next); }, () => { if (current) setUrl(null); });
    return () => {
      current = false;
      setUrl(null);
      held.release();
    };
  }, [bytes, mimeType]);
  return url;
};
