import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AttachmentContents } from "./attachmentFile";

// The attachments being downloaded, by id: kept here rather than in a component, since a download
// outlives the viewer, the grid and the chat it started in, and pressing Download again on the
// file, in any of them, must find it.
const downloads = new Set<string>();
const downloadListeners = new Set<() => void>();
let downloadsShown: ReadonlySet<string> = new Set();
const changeDownloads = (change: () => void) => {
  change();
  downloadsShown = new Set(downloads);
  for (const listener of downloadListeners) listener();
};
const subscribeToDownloads = (listener: () => void) => {
  downloadListeners.add(listener);
  return () => { downloadListeners.delete(listener); };
};

type Read = {
  bytes: Promise<Uint8Array>;
  abort: AbortController;
  failed: boolean;
};

// The reads that feed those downloads. Leaving the chat lets these finish, and only these: a
// preview of the same file, opened after coming back, still stops.
const downloadReads = new WeakSet<Read>();

/**
 * Reads each attachment's bytes once, as one promise, so a card's thumbnail and the viewer share a
 * fetch under way and the viewer can read it with `use()`. A read is kept only while held: while a
 * card makes its thumbnail from it, while the viewer shows the file, or until a download of it is
 * saved. So a chat keeps no file's bytes it isn't using, and moving on from a large file, or
 * closing the viewer, stops its fetch and drops its bytes. A failed read stays remembered, or each render of
 * the failure would read again, until `forgetFailures` is called: when a person opens the viewer,
 * which is how they retry. Only the attachments in `liveIds` are kept: a file removed from the
 * composer, or sent, gives its bytes back. `load` gets a signal that aborts when its read is
 * dropped or the component goes, as leaving a chat does, unless a download is waiting for it.
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
  const downloading = useSyncExternalStore(subscribeToDownloads, () => downloadsShown);
  const drop = (id: string, read: Read) => {
    if (reads.current.get(id) !== read) return;
    reads.current.delete(id);
    read.abort.abort();
  };
  useEffect(() => {
    const current = reads.current;
    return () => {
      // A download asked for goes on to be saved.
      for (const read of current.values()) if (!downloadReads.has(read)) read.abort.abort();
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
        bytes: loadRef.current(id, abort.signal), abort, failed: false,
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
          if (read && !holds.current.has(id)) drop(id, read);
        });
      };
    };
    const forgetFailures = () => {
      for (const [id, read] of reads.current) {
        if (read.failed) reads.current.delete(id);
      }
    };
    return {
      read: (id) => start(id).bytes,
      readOnce: (id, signal) => {
        const release = hold(id);
        signal.addEventListener("abort", release, { once: true });
        return start(id).bytes.finally(release);
      },
      hold,
      forgetFailures,
      download: (id, save) => {
        if (downloads.has(id)) return undefined;
        changeDownloads(() => downloads.add(id));
        if (reads.current.get(id)?.failed) reads.current.delete(id);
        const release = hold(id);
        const read = start(id);
        downloadReads.add(read);
        return read.bytes.then(save).finally(() => {
          release();
          changeDownloads(() => downloads.delete(id));
        });
      },
    };
  });
  return { ...stable, downloading };
};
