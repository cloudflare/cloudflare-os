import { useRef } from "react";
import type { AttachmentContentLoader } from "./attachmentFile";

/**
 * Remembers each attachment's bytes as one promise, so a card's thumbnail and the viewer share a
 * single fetch and the viewer can read it with `use()`. A failed fetch stays remembered, or each
 * render of the failure would fetch again, until `forgetFailures` is called: when a person opens
 * the viewer, which is how they retry.
 */
export const useAttachmentContents = (load: AttachmentContentLoader) => {
  const loadRef = useRef(load);
  loadRef.current = load;
  const contents = useRef(new Map<string, Promise<Uint8Array>>());
  const failed = useRef(new Set<string>());

  const content: AttachmentContentLoader = (id) => {
    let cached = contents.current.get(id);
    if (!cached) {
      cached = loadRef.current(id);
      contents.current.set(id, cached);
      cached.catch(() => failed.current.add(id));
    }
    return cached;
  };

  const forgetFailures = () => {
    for (const id of failed.current) contents.current.delete(id);
    failed.current.clear();
  };

  return { content, forgetFailures };
};
