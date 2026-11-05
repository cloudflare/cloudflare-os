import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardScrolls } from "./scrollForwarding.ts";

const WHEEL_PAUSE_MS = 250;

const forwardScroll = vi.fn<(deltaX: number, deltaY: number) => void>();
let header: HTMLElement;
let list: HTMLElement;

beforeAll(() => forwardScrolls({ forwardScroll }));

beforeEach(async () => {
  document.body.innerHTML = '<p>Header</p><div style="height: 100px; overflow-y: auto"><div style="height: 1000px"></div></div>';
  [header, list] = [document.body.children[0] as HTMLElement, document.body.children[1] as HTMLElement];
  // A wheel gesture ends once the wheel pauses, so each test starts its own.
  await new Promise(resolve => setTimeout(resolve, WHEEL_PAUSE_MS));
  forwardScroll.mockClear();
});

/** Dispatches a wheel tick, returning whether the frame cancelled it. */
const wheel = (target: Element, deltaY: number, init: WheelEventInit = {}) =>
  !target.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true, ...init }));

const touch = (type: "touchstart" | "touchmove", target: Element, clientY: number) =>
  target.dispatchEvent(new TouchEvent(type, {
    bubbles: true, touches: [new Touch({ identifier: 1, target, clientX: 0, clientY })],
  }));

/** Settles once scrolls the frame forwards, sent once per animation frame, have reached the host. */
const forwarded = () => new Promise(resolve => requestAnimationFrame(resolve));

describe("scroll forwarding", () => {
  it("leaves a wheel gesture the list took to the list, even once it reaches its end", async () => {
    expect(wheel(list, 100)).toBe(false);
    list.scrollTop = list.scrollHeight;
    expect(wheel(list, 100)).toBe(false);

    await forwarded();
    expect(forwardScroll).not.toHaveBeenCalled();
  });

  it("keeps forwarding a wheel gesture once the modal slides the list under the pointer", async () => {
    wheel(header, 100);
    expect(wheel(list, 100)).toBe(true);

    await forwarded();
    expect(forwardScroll).toHaveBeenCalledExactlyOnceWith(0, 200);
  });

  it("gives a wheel gesture that turns back to whatever can take it then", async () => {
    list.scrollTop = list.scrollHeight;
    expect(wheel(list, 100)).toBe(true);
    expect(wheel(list, -100)).toBe(false);

    await forwarded();
    expect(forwardScroll).toHaveBeenCalledExactlyOnceWith(0, 100);
  });

  it("gives the next wheel gesture to whatever is under the pointer then", async () => {
    wheel(header, 100);
    await new Promise(resolve => setTimeout(resolve, WHEEL_PAUSE_MS));
    expect(wheel(list, 100)).toBe(false);

    await forwarded();
    expect(forwardScroll).toHaveBeenCalledExactlyOnceWith(0, 100);
  });

  it("leaves pinch and Ctrl+wheel zoom to the browser", async () => {
    expect(wheel(header, 100, { ctrlKey: true })).toBe(false);

    await forwarded();
    expect(forwardScroll).not.toHaveBeenCalled();
  });

  it("leaves a touch the list took to the list, even once it reaches its end", async () => {
    touch("touchstart", list, 300);
    touch("touchmove", list, 250);
    list.scrollTop = list.scrollHeight;
    touch("touchmove", list, 200);

    await forwarded();
    expect(forwardScroll).not.toHaveBeenCalled();
  });
});
