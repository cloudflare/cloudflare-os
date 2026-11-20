/**
 * What `reader` has left, read from it only as the result is read, so none of it is held here.
 * The stream fails with `tooLarge` once it has carried more than `maxBytes`, and the download is
 * let go however it ends.
 */
export function cappedStream(
  reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number, tooLarge: string,
): ReadableStream<Uint8Array> {
  let carried = 0;
  let carry = async (controller: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array) => {
    carried += bytes.byteLength;
    if (carried <= maxBytes) return controller.enqueue(bytes);
    controller.error(new Error(tooLarge));
    await reader.cancel().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk = await reader.read();
      if (chunk.done) return controller.close();
      await carry(controller, chunk.value);
    },
    cancel: reason => reader.cancel(reason),
  }, { highWaterMark: 0 });
}
