/**
 * What `reader` has left after `head`, read from it only as the result is read, so none of it is
 * held here. The stream fails with `tooLarge` once it has carried more than `maxBytes`, `head`
 * included, and the download is let go however it ends.
 */
export function cappedStream(
  reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number, tooLarge: string,
  head = new Uint8Array(),
): ReadableStream<Uint8Array> {
  let carried = 0;
  let carry = async (controller: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array) => {
    carried += bytes.byteLength;
    if (carried <= maxBytes) return controller.enqueue(bytes);
    controller.error(new Error(tooLarge));
    await reader.cancel().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.byteLength > 0) return carry(controller, head);
    },
    async pull(controller) {
      let chunk = await reader.read();
      if (chunk.done) return controller.close();
      await carry(controller, chunk.value);
    },
    cancel: reason => reader.cancel(reason),
  }, { highWaterMark: 0 });
}

/** How much of a stream of bytes already held one message carries. */
const CHUNK_BYTES = 64 * 1024;

/** `bytes` as a stream, in pieces small enough that none holds up what else its connection carries. */
export function chunkedStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(bytes.subarray(at, at += CHUNK_BYTES));
      if (at >= bytes.byteLength) controller.close();
    },
  }, { highWaterMark: 0 });
}
