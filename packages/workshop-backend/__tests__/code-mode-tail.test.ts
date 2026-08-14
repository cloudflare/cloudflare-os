import { expect, it, vi } from "vitest";
import { CodeModeTailLoopback } from "../src/overseer.js";

const trace = (rpcMethod: string) => ({
  event: { rpcMethod }, logs: [], exceptions: [], diagnosticsChannelEvents: [],
}) as unknown as TraceItem;

it("delivers only a run paired with one verify", async () => {
  const deliverCodeModeTrace = vi.fn(async () => undefined);
  const loopback = { ctx: {
    props: { executionId: "execution", overseerId: "overseer" },
    exports: { OverseerDurableObject: {
      idFromString: (id: string) => id,
      get: () => ({ deliverCodeModeTrace }),
    } },
  } };
  const tail = (...methods: string[]) => CodeModeTailLoopback.prototype.tail.call(
    loopback as unknown as CodeModeTailLoopback, methods.map(trace));
  await tail("verify", "run");
  expect(deliverCodeModeTrace).toHaveBeenCalledOnce();
  expect(deliverCodeModeTrace.mock.calls[0]?.[1]).toMatchObject({ event: { rpcMethod: "run" } });
  for (const methods of [["verify", "other"], ["verify", "verify", "run"], ["run", "run"]]) {
    deliverCodeModeTrace.mockClear(); await tail(...methods); expect(deliverCodeModeTrace).not.toHaveBeenCalled();
  }
});
