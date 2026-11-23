import { useEffect, useRef, useState } from "react";
import type { AttachmentContents } from "./attachmentFile";

type Read = {
  bytes: Promise<Uint8Array>;
  abort: AbortController;
  /** Whether a card asked for it, which keeps it while the component is mounted. */
  kept: boolean;
  failed: boolean;
};

/**
 * Reads each attachment's bytes once, as one promise, so a card's thumbnail and the viewer share a
 * single fetch and the viewer can read it with `use()`. A read a card asks for is kept while the
 * component is mounted. One only the viewer asks for is kept while held: while the viewer shows
 * the file, or until a download of it is saved. So moving on from a large file, or closing the
 * viewer, stops its fetch and drops its bytes. A failed read stays remembered, or each render of
 * the failure would read again, until `forgetFailures` is called: when a person opens the viewer,
 * which is how they retry. Only the attachments in `liveIds` are kept: a file removed from the
 * composer, or sent, gives its bytes back. `load` gets a signal that aborts when its read is
 * dropped or the component goes, as leaving a chat does.
 */
export const useAttachmentContents = (
  load: (id: string, signal: AbortSignal) => Promise<Uint8Array>,
  liveIds: readonly string[],
): AttachmentContents => {
  const loadRef = useRef(load);
  loadRef.current = load;
  const reads = useRef(new Map<string, Read>());
  // By file, not by read: holding a file starts no read, and holds one started after.
  const holds = useRef(new Map<string, number>());
  // Here rather than in the viewer, which a download outlives: reopened, it still shows the
  // download under way, and pressing Download again does nothing until the file is saved.
  const [downloading, setDownloading] = useState<ReadonlySet<string>>(() => new Set());
  const downloads = useRef(new Set<string>());
  const drop = (id: string, read: Read) => {
    if (reads.current.get(id) !== read) return;
    reads.current.delete(id);
    read.abort.abort();
  };
  useEffect(() => {
    const current = reads.current;
    return () => {
      for (const read of current.values()) read.abort.abort();
      current.clear();
    };
  }, []);
  for (const [id, read] of reads.current) {
    if (!liveIds.includes(id)) drop(id, read);
  }

  // Stable, so the viewer's effects can depend on its functions; everything they read is in refs.
  const [stable] = useState<Omit<AttachmentContents, "downloading">>(() => {
    const start = (id: string): Read => {
      const started = reads.current.get(id);
      if (started) return started;
      const abort = new AbortController();
      const read: Read = {
        bytes: loadRef.current(id, abort.signal), abort, kept: false, failed: false,
      };
      read.bytes.catch(() => { read.failed = true; });
      reads.current.set(id, read);
      return read;
    };
    const hold = (id: string) => {
      holds.current.set(id, (holds.current.get(id) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = holds.current.get(id)! - 1;
        if (left > 0) holds.current.set(id, left);
        else holds.current.delete(id);
        // Once the work at hand is done, so a hold let go and taken straight back, as
        // StrictMode does with an effect, keeps the read.
        queueMicrotask(() => {
          const read = reads.current.get(id);
          if (read && !read.kept && !holds.current.has(id)) drop(id, read);
        });
      };
    };
    const forgetFailures = () => {
      for (const [id, read] of reads.current) {
        if (read.failed) reads.current.delete(id);
      }
    };
    const showDownloads = () => setDownloading(new Set(downloads.current));
    return {
      content: (id) => {
        const read = start(id);
        read.kept = true;
        return read.bytes;
      },
      read: (id) => start(id).bytes,
      hold,
      forgetFailures,
      download: (id, save) => {
        if (downloads.current.has(id)) return undefined;
        downloads.current.add(id);
        showDownloads();
        if (reads.current.get(id)?.failed) reads.current.delete(id);
        const release = hold(id);
        return start(id).bytes.then(save).finally(() => {
          release();
          downloads.current.delete(id);
          showDownloads();
        });
      },
    };
  });
  return { ...stable, downloading };
};
