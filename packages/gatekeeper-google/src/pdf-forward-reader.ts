// A range reader over a PDF that can only be read from its start, as a Gmail attachment is. The
// page images of a scan are asked for one after another, almost always in the file's own order,
// so one pass over a single open stream serves them, and nothing of the file is held between them.

import type { PdfRangeReader, PdfSource } from "./drive-pdf";

/**
 * Opens the file's bytes from their start. `page` is the page image about to be read, absent
 * when the whole file is wanted; `again` says the pass before it broke or stalled.
 */
export type PdfOpener = (purpose: { page?: number; again: boolean }) => Promise<ReadableStream<Uint8Array>>;

/** How long a read of the pass may be outstanding with no chunk, unless told, before the pass has stalled. */
const STALL_MS = 15_000;
/** How many passes a reader opens for a range that starts before where its pass has got to. */
const MAX_BACKWARD_OPENS = 4;
/** What a range fails with when the pass stalled under it a second time. */
const STALLED = "The PDF stopped arriving while a page was being read; read it again.";
/** What a range fails with once its reader was released, or was asked for another before it ended. */
const LET_GO = "The PDF is no longer being read.";

/** The one open stream of the file that page images are read from. */
type Pass = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Where in the file the pass stands: the offset of the next byte it gives. */
  at: number;
  /** What is left of the chunk the pass stands in, when it stands inside one. */
  rest?: Uint8Array;
  /** The clock of the read of it that is outstanding, or of its last. */
  timer?: ReturnType<typeof setTimeout>;
};

/** A page image being read from the pass. */
type Range = {
  page: number;
  /** Where in the file the range has got to, and where it ends. */
  at: number;
  end: number;
  /** Whether the pass has broken or stalled under this range. */
  again: boolean;
  /** Whether the range has ended, failed or been given up. */
  over: boolean;
  moved?: () => void;
};

/**
 * A range reader over a file that can only be read from its start, and what lets it go.
 *
 * A range with no `page`, the whole file, is `open`'s stream as it is, one of its own each time.
 * Every other range is read from one pass over the file: what lies before the range is read and
 * dropped (`moved` is called for each chunk of it), the range's own bytes are read only as its
 * stream is, and the pass then stays open, unread, for the next range. Between ranges nothing of
 * the file is kept but the rest of the chunk the last range ended in.
 *
 * A range that starts before where the pass has got to, as the image of a page that an update to
 * the file defined again does, has a new pass opened for it: {@link MAX_BACKWARD_OPENS} times for
 * one reader, after which such a range is refused as a failed transcription.
 *
 * A pass breaks when a read of it fails or it ends before the range does, and stalls when a read
 * of it is outstanding for `stallMs` with no chunk. Only an outstanding read is timed: a range is
 * read at the pace of whatever takes it. Either way the pass is let go and another opened, once
 * for each range, which goes on from where it had got to. A second time fails the range: with
 * what the read failed with, as a changed file when it ended short, or in words for a stall. What
 * `open` rejects with is passed on as it is, and not tried again.
 *
 * A range asked for while another is unfinished, or cancelled before its end, lets the pass go.
 * `release()` lets everything go: the pass, a range being waited for, which rejects, and the
 * stream of an `open` that answers afterwards. No range is read after it.
 */
export function forwardRangeReader(
  open: PdfOpener, source: PdfSource, options: { stallMs?: number } = {},
): { readRange: PdfRangeReader; release(): void } {
  let stallMs = options.stallMs ?? STALL_MS;
  let pass: Pass | undefined;
  /** The range being read from the pass, until it is over. */
  let current: Range | undefined;
  /** How many passes were opened for a range that starts before where the pass had got to. */
  let backward = 0;
  let released = false;

  /** Lets the pass go. */
  let drop = () => {
    if (pass?.timer !== undefined) clearTimeout(pass.timer);
    void pass?.reader.cancel().catch(() => undefined);
    pass = undefined;
  };
  /** Gives up the range being read, and the pass, which stands somewhere inside it. */
  let giveUp = () => {
    if (current) current.over = true;
    current = undefined;
    drop();
  };

  /** Opens the file, letting go of a stream that arrives once `unwanted` says nothing waits for it. */
  let opened = async (purpose: { page?: number; again: boolean }, unwanted: () => boolean) => {
    let stream = await open(purpose);
    if (unwanted()) {
      await stream.cancel().catch(() => undefined);
      throw new Error(LET_GO);
    }
    return stream;
  };

  /** Up to `most` of the bytes `from` gives next: the rest of their chunk is kept for what is taken next. */
  let take = async (from: Pass, range: Range, most: number): Promise<Uint8Array> => {
    let bytes = from.rest;
    if (!bytes) {
      let clock!: ReturnType<typeof setTimeout>;
      let stalled = new Promise<never>((_, reject) => {
        clock = setTimeout(() => reject(new Error(STALLED)), stallMs);
      });
      from.timer = clock;
      let chunk = await Promise.race([from.reader.read(), stalled]).finally(() => clearTimeout(clock));
      // Letting a pass go ends a read of it the way the file's own end does.
      if (range.over) throw new Error(LET_GO);
      if (chunk.done) throw new Error(source.changed);
      bytes = chunk.value;
    }
    let taken = bytes.subarray(0, most);
    from.rest = taken.byteLength < bytes.byteLength ? bytes.subarray(most) : undefined;
    from.at += taken.byteLength;
    return taken;
  };

  /**
   * Does `work` on the pass once it stands where `range` has got to, opening one when there is
   * none. A pass that breaks or stalls on the way, or under `work`, is let go, and all of it is
   * done again on a new one, once for the range.
   */
  let onPass = async <T>(range: Range, work: (from: Pass) => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        if (range.over) throw new Error(LET_GO);
        if (!pass) {
          let stream = await opened({ page: range.page, again: range.again }, () => range.over);
          pass = { reader: stream.getReader(), at: 0 };
        }
        let from = pass;
        while (from.at < range.at) {
          await take(from, range, range.at - from.at);
          range.moved?.();
        }
        return await work(from);
      } catch (error) {
        if (range.over) throw error;
        // With no pass, it is the open that failed, which is not tried again.
        if (!pass || range.again) {
          giveUp();
          throw error;
        }
        drop();
        range.again = true;
      }
    }
  };

  return {
    async readRange({ page, offset, length }, moved) {
      if (released) throw new Error(LET_GO);
      if (page === undefined) return opened({ again: false }, () => released);
      // The pass has one place: a range that has not ended when the next is asked for is given up.
      if (current) giveUp();
      if (pass && offset < pass.at) {
        drop();
        if (backward === MAX_BACKWARD_OPENS) throw new Error(source.transcriptionFailed);
        backward++;
      }
      let range: Range = { page, at: offset, end: offset + length, again: false, over: false, moved };
      current = range;
      await onPass(range, async () => undefined);
      // Given up while the pass was brought to it: by a release, or by the range asked for next.
      if (range.over) throw new Error(LET_GO);
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            let bytes = await onPass(range, from => take(from, range, range.end - range.at));
            // Given up while these were on their way: the pass they came from is another range's
            // now, or nobody's, so they are not this range's to give.
            if (range.over) throw new Error(LET_GO);
            range.at += bytes.byteLength;
            controller.enqueue(bytes);
            if (range.at < range.end) return;
            range.over = true;
            current = undefined;
            controller.close();
          } catch (error) {
            // Nothing comes of this for a stream that was cancelled.
            controller.error(error);
          }
        },
        cancel() {
          if (!range.over) giveUp();
        },
      }, { highWaterMark: 0 });
    },
    release() {
      released = true;
      giveUp();
    },
  };
}
