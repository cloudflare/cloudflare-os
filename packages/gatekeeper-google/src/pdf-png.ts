// Makes a PNG of an image's rows of samples, as they stream past, from either of two places. A
// PDF keeps a losslessly compressed image as deflated rows of samples, which is what a PNG's
// image data is, so the PNG of one is the PDF's own bytes inside PNG's framing whenever the rows
// already carry PNG's filter bytes, and is re-deflated with one added to each row when they do
// not: no pixel is decoded. Rows of samples that are not deflated, which a rendered page's are,
// are given filter bytes and deflated a step at a time. Either way the PNG is produced only as
// it is read, and the image is never held whole here.

import type { PngLayout } from "./pdf-images";

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

/**
 * Bytes of deflated data inflated before what they hold is waited for. Deflate packs a thousand
 * times at most, and a scan a few, so this bounds the samples waiting to be read whatever the
 * data: some megabytes of them at the very worst, and for a scan some tens of kilobytes.
 */
const INFLATE_STEP_BYTES = 16 * 1024;
/** Bytes of samples deflated before what they come to is waited for, which is no more than they. */
const DEFLATE_STEP_BYTES = 256 * 1024;
/**
 * Bytes at the end of deflated data that are inflated apart from the rest: a line end, which is
 * the most a PDF's count of the data is out by. A file may count the line end after the data into
 * it, or the data's last bytes may have been taken for one, and a stream given a byte past its
 * end fails with what it was fed alongside, so no row is fed in with those.
 */
const LINE_END_BYTES = 2;

/**
 * An image's data is not what its dictionary describes: it does not inflate, holds other than
 * the image's rows, or makes a PNG larger than may be sent.
 */
export class ImageDataError extends Error {
  constructor() {
    super("The image's data is not the rows of samples its dictionary describes.");
  }
}

/** One PNG chunk: its length, type, data and the checksum of the last two. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  let out = new Uint8Array(12 + data.byteLength);
  let view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < 8 + data.byteLength; i++) crc = CRC_TABLE[(crc ^ out[i]!) & 0xff]! ^ (crc >>> 8);
  view.setUint32(8 + data.byteLength, ~crc >>> 0);
  return out;
}

/** Fails as data a compression stream cannot read does. */
function unreadable(): never {
  throw new ImageDataError();
}

/** `first` followed by `second`, as one array. */
function joined(first: Uint8Array, second: Uint8Array): Uint8Array {
  let both = new Uint8Array(first.byteLength + second.byteLength);
  both.set(first);
  both.set(second, first.byteLength);
  return both;
}

/** Marks a promise's failure as seen to, for one that may fail while nothing is waiting on it. */
function unwatched<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/**
 * `source` put through `transform`, one of the runtime's compression streams, and read only as
 * the result is: `step` bytes of it are fed in at a time, and no more until what they came to
 * has been read. The source's last `apart` bytes are fed in on their own, and its end after them.
 * Cancelling the result cancels `source` at once. A failure of `source` is passed on as it is,
 * and one of `transform`, which is what data it cannot read causes, as an {@link ImageDataError}.
 *
 * The streams are not piped, because workerd's compression streams take every write at once,
 * whether or not anything reads what comes of it: a pipe draws the whole source in and holds all
 * it becomes, and does not pass a cancel back while it waits on its source. Nor do they say when
 * they have nothing more to give for what they were fed, so a read is given a turn of the event
 * loop, which is longer than one that can be answered takes, before more is fed in. That is a
 * timer, so this does not run under fake ones.
 */
function putThrough(
  source: ReadableStream<Uint8Array>, transform: TransformStream<Uint8Array, Uint8Array>, step: number,
  apart = 0,
): ReadableStream<Uint8Array> {
  let input = source.getReader();
  let writer = transform.writable.getWriter();
  let output = transform.readable.getReader();
  /** What has been read of the source and not yet fed in, of which the last `apart` bytes wait. */
  let rest: Uint8Array = new Uint8Array(0);
  let inputEnded = false;
  /** The next `step` bytes of the source on their way in. */
  let feeding: Promise<void> | undefined;
  /** The read of the result that is waiting, which may outlast the pull that began it. */
  let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let timer!: ReturnType<typeof setTimeout>;
  let feed = async () => {
    for (let fed = 0; fed < step;) {
      if (rest.byteLength <= apart) {
        let piece = await input.read();
        if (!piece.done) {
          rest = rest.byteLength === 0 ? piece.value : joined(rest, piece.value);
          continue;
        }
        // The source has ended: what waited is a step of its own, and the end one more.
        if (fed > 0) return;
        if (rest.byteLength === 0) {
          inputEnded = true;
          return writer.close().catch(unreadable);
        }
        await writer.write(rest).catch(unreadable);
        rest = new Uint8Array(0);
        return;
      }
      let part = rest.subarray(0, Math.min(step - fed, rest.byteLength - apart));
      rest = rest.subarray(part.byteLength);
      fed += part.byteLength;
      await writer.write(part).catch(unreadable);
    }
  };
  let release = async (reason?: unknown) => {
    clearTimeout(timer);
    await Promise.allSettled([input.cancel(reason), writer.abort(reason), output.cancel(reason)]);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // A pull that enqueues nothing is not called again, so an empty piece is read past.
        for (;;) {
          reading ??= unwatched(output.read().catch(unreadable));
          // Wait for something to read; failing that, for what is being fed in to have been,
          // or with nothing on its way in, for a turn to pass with nothing there to read.
          let waited = feeding ?? (inputEnded ? reading
            : new Promise<void>(resolve => { timer = setTimeout(resolve, 0); }));
          let piece = await Promise.race([reading, waited.then(() => undefined)]);
          clearTimeout(timer);
          if (piece) {
            reading = undefined;
            if (piece.done) return controller.close();
            if (piece.value.byteLength > 0) return controller.enqueue(piece.value);
          } else if (feeding) {
            feeding = undefined;
          } else {
            feeding = unwatched(feed());
          }
        }
      } catch (error) {
        await release(error);
        throw error;
      }
    },
    cancel: release,
  }, { highWaterMark: 0 });
}

/**
 * `samples` with PNG's "no filter" byte put before each row of `rowBytes`, read only as the
 * result is. Fails with an {@link ImageDataError} as soon as there are more than `height` rows,
 * and at the end when there are fewer. Once the rows are all there the image is whole, so samples
 * that then fail as data that cannot be read does are ended there instead: what follows the rows
 * is the data's checksum, which a line end taken for the data, or from it, puts out.
 */
function filteredRows(
  samples: ReadableStream<Uint8Array>, rowBytes: number, height: number,
): ReadableStream<Uint8Array> {
  let reader = samples.getReader();
  /** Bytes of the current row already passed on, and of all the rows still to come. */
  let inRow = 0;
  let left = rowBytes * height;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let piece = await reader.read().catch((error: unknown): ReadableStreamReadResult<Uint8Array> => {
        if (left > 0 || !(error instanceof ImageDataError)) throw error;
        return { done: true, value: undefined };
      });
      left -= piece.value?.byteLength ?? 0;
      if (piece.done ? left > 0 : left < 0) {
        await reader.cancel().catch(() => undefined);
        throw new ImageDataError();
      }
      if (piece.done) return controller.close();
      let rows = piece.value;
      let out = new Uint8Array(rows.byteLength + Math.ceil(rows.byteLength / rowBytes) + 1);
      let length = 0;
      for (let at = 0; at < rows.byteLength;) {
        if (inRow === 0) out[length++] = 0;
        let take = Math.min(rowBytes - inRow, rows.byteLength - at);
        out.set(rows.subarray(at, at + take), length);
        length += take;
        at += take;
        inRow = (inRow + take) % rowBytes;
      }
      controller.enqueue(out.subarray(0, length));
    },
    cancel: reason => reader.cancel(reason),
  }, { highWaterMark: 0 });
}

/**
 * A PNG of the image whose deflated data is `data`, produced only as it is read, and holding at
 * most `maxBytes` of image data. Cancelling it cancels `data` at once, and `data` failing fails
 * it in the same way.
 *
 * Rows without filter bytes are inflated to be given them, so their data is checked on the way:
 * the PNG fails with an {@link ImageDataError} when it does not inflate, when it holds other
 * than `height` rows (so no more than that is ever inflated), or when the PNG would be larger
 * than `maxBytes`. Data that is out by a line end after its rows, one too many or the checksum's
 * last bytes too few, is still those rows, as it is to a PDF reader. Rows that carry filter bytes
 * are passed on unread, and data that is not what the dictionary says then makes a PNG its
 * reader will refuse.
 */
export function pngFromDeflated(
  data: ReadableStream<Uint8Array>, size: { width: number; height: number }, layout: PngLayout,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  if (layout.filtered) return framed(data, size, layout, maxBytes);
  return pngFromSamples(
    putThrough(data, new DecompressionStream("deflate") as TransformStream<Uint8Array, Uint8Array>,
      INFLATE_STEP_BYTES, LINE_END_BYTES),
    size, layout, maxBytes);
}

/**
 * A PNG of the image whose rows of samples are `samples`, as `layout` describes them and without
 * filter bytes, produced only as it is read, and holding at most `maxBytes` of image data. The
 * rows are given PNG's "no filter" byte and deflated a step at a time, as the PNG is read.
 * Cancelling it cancels `samples` at once, and `samples` failing fails it in the same way. It
 * fails with an {@link ImageDataError} when there are other than `height` rows, or when the PNG
 * would be larger than `maxBytes`.
 */
export function pngFromSamples(
  samples: ReadableStream<Uint8Array>, size: { width: number; height: number }, layout: PngLayout,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  return framed(
    putThrough(filteredRows(samples, layout.rowBytes, size.height),
      new CompressionStream("deflate") as TransformStream<Uint8Array, Uint8Array>, DEFLATE_STEP_BYTES),
    size, layout, maxBytes);
}

/**
 * `rows`, a PNG's deflated image data, inside PNG's framing, read only as the result is: the
 * signature and the header, a chunk of image data for each piece of `rows`, and the end. Fails
 * with an {@link ImageDataError}, and cancels `rows`, once they are more than `maxBytes`.
 * Cancelling it cancels `rows`, and `rows` failing fails it in the same way.
 */
function framed(
  rows: ReadableStream<Uint8Array>, size: { width: number; height: number }, layout: PngLayout,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let reader = rows.getReader();
  let left = maxBytes;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let header = new Uint8Array(13);
      let view = new DataView(header.buffer);
      view.setUint32(0, size.width);
      view.setUint32(4, size.height);
      header[8] = layout.bitDepth;
      header[9] = layout.colorType;
      controller.enqueue(SIGNATURE);
      controller.enqueue(chunk("IHDR", header));
    },
    async pull(controller) {
      // A pull that enqueues nothing is not called again, so an empty piece is read past.
      for (;;) {
        let piece = await reader.read();
        if (piece.done) {
          controller.enqueue(chunk("IEND", new Uint8Array(0)));
          controller.close();
          return;
        }
        if ((left -= piece.value.byteLength) < 0) {
          await reader.cancel().catch(() => undefined);
          throw new ImageDataError();
        }
        if (piece.value.byteLength > 0) {
          controller.enqueue(chunk("IDAT", piece.value));
          return;
        }
      }
    },
    cancel: reason => reader.cancel(reason),
  }, { highWaterMark: 0 });
}
