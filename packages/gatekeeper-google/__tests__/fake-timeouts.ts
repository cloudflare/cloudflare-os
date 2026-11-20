import {vi} from "vitest";

/** `AbortSignal.timeout()` on the fake clock, which fake timers otherwise leave real. */
export function timeoutsOnFakeClock(): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
    return controller.signal;
  });
}
