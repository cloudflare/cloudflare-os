import { RpcStub } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { startGitPull } from "../../src/git-pull-transfer";
import { encodePktLine, FLUSH_PKT } from "../../src/git-transport";

const OIDS = ["a".repeat(40)];
const OPTIONS = {type: "commit", commitHistory: {kind: "depth", depth: 1}} as const;

function unclaimedTransfer() {
  const canceled = Promise.withResolvers<void>();
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancellations++;
      canceled.resolve();
    },
  }, {highWaterMark: 0});
  return {
    transfer: startGitPull(async () => new Response(body), OIDS, OPTIONS),
    canceled: canceled.promise,
    cancellations: () => cancellations,
  };
}

describe("Git pull transfer lifetime in workerd", () => {
  it("cancels an unclaimed upstream response when its RPC stub is disposed", async () => {
    const fixture = unclaimedTransfer();
    const transfer = await fixture.transfer;
    const stub = new RpcStub(transfer);
    expect(await stub.status()).toEqual({state: "streaming"});

    stub[Symbol.dispose]();
    await fixture.canceled;

    expect(fixture.cancellations()).toBe(1);
    expect(await transfer.status()).toEqual({state: "canceled"});
  });

  it("keeps an unclaimed response open until the last RPC stub is disposed", async () => {
    const fixture = unclaimedTransfer();
    const transfer = await fixture.transfer;
    const stub = new RpcStub(transfer);
    const duplicate = stub.dup();

    stub[Symbol.dispose]();
    expect(await duplicate.status()).toEqual({state: "streaming"});
    expect(fixture.cancellations()).toBe(0);

    duplicate[Symbol.dispose]();
    await fixture.canceled;
    expect(fixture.cancellations()).toBe(1);
  });

  it("leaves a claimed stream with its consumer when the RPC stub is disposed", async () => {
    const pack = new TextEncoder().encode("PACK payload");
    const sideband = new Uint8Array([
      ...new TextEncoder().encode((pack.length + 5).toString(16).padStart(4, "0")), 1, ...pack,
    ]);
    const framed = new Uint8Array(await new Blob([
      encodePktLine("packfile"), sideband, FLUSH_PKT,
    ]).arrayBuffer());
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(framed);
        controller.close();
      },
      cancel() { cancellations++; },
    }, {highWaterMark: 0});
    const transfer = await startGitPull(async () => new Response(body), OIDS, OPTIONS);
    const stub = new RpcStub(transfer);
    const stream = await stub.stream();

    stub[Symbol.dispose]();
    expect(cancellations).toBe(0);
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(pack);
    expect(await transfer.status()).toEqual({state: "complete"});
    expect(cancellations).toBe(0);
  });
});
