import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callSlots, pixelRoom, pixelsHeld, READ_AHEAD, type PixelHold } from "../src/pdf-read-ahead";

/** A signal that never aborts. */
const NEVER = new AbortController().signal;

/** Lets everything that can go on without a timer do so. */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** Calls that say when they begin, by name, and end when told to. */
function calls() {
  let begun: string[] = [];
  let ends = new Map<string, { resolve: (name: string) => void; reject: (error: unknown) => void }>();
  return {
    begun,
    /** A call named `name`, which resolves with its name. */
    call: (name: string) => () => new Promise<string>((resolve, reject) => {
      begun.push(name);
      ends.set(name, { resolve, reject });
    }),
    end: (name: string) => ends.get(name)!.resolve(name),
    fail: (name: string, error: unknown) => ends.get(name)!.reject(error),
  };
}

describe("callSlots", () => {
  it("runs as many calls at once as its limit, and the next when one settles, however it settles", async () => {
    let slots = callSlots(2);
    let { begun, call, end, fail } = calls();
    let page = slots.of(0);
    let first = page.run(NEVER, call("a"));
    let second = page.run(NEVER, call("b"));
    let third = page.run(NEVER, call("c"));
    let fourth = page.run(NEVER, call("d"));
    await tick();
    expect(begun).toEqual(["a", "b"]);
    expect(slots).toMatchObject({ limit: 2, inFlight: 2 });

    end("a");
    expect(await first).toBe("a");
    await tick();
    expect(begun).toEqual(["a", "b", "c"]);
    expect(slots.inFlight).toBe(2);

    // A call that fails frees its slot too, and fails as it did.
    let broke = new Error("The call failed.");
    fail("b", broke);
    await expect(second).rejects.toBe(broke);
    await tick();
    expect(begun).toEqual(["a", "b", "c", "d"]);

    end("c");
    end("d");
    expect(await Promise.all([third, fourth])).toEqual(["c", "d"]);
    expect(slots.inFlight).toBe(0);
  });

  it("lets the lowest page go first among those waiting, and of one page the first to ask", async () => {
    let slots = callSlots(1);
    let { begun, call, end } = calls();
    let running = [slots.of(5).run(NEVER, call("page 6"))];
    // Asked in this order while the one slot is taken.
    for (let [page, name] of [[3, "page 4"], [1, "page 2"], [3, "page 4 again"], [1, "page 2 again"], [0, "page 1"]] as const) {
      running.push(slots.of(page).run(NEVER, call(name)));
    }
    let order = ["page 6", "page 1", "page 2", "page 2 again", "page 4", "page 4 again"];
    for (let [index, name] of order.entries()) {
      await tick();
      expect(begun).toEqual(order.slice(0, index + 1));
      end(name);
    }
    expect(await Promise.all(running)).toHaveLength(6);
    expect(slots.inFlight).toBe(0);
  });

  it("rejects a wait that its signal ends with the signal's reason, and gives it no slot", async () => {
    let slots = callSlots(1);
    let { begun, call, end } = calls();
    let page = slots.of(0);
    let first = page.run(NEVER, call("a"));
    let waiting = new AbortController();
    let second = page.run(waiting.signal, call("b"));
    let third = page.run(NEVER, call("c"));
    await tick();
    expect(begun).toEqual(["a"]);

    let reason = new Error("The text was cancelled.");
    waiting.abort(reason);
    await expect(second).rejects.toBe(reason);
    expect(slots.inFlight).toBe(1);

    // The slot goes to the one behind it, and the call given up is never made.
    end("a");
    await first;
    await tick();
    expect(begun).toEqual(["a", "c"]);
    end("c");
    await third;
    expect(slots.inFlight).toBe(0);

    // Nor is a call made for a signal that had aborted before it asked.
    await expect(page.run(AbortSignal.abort(reason), call("d"))).rejects.toBe(reason);
    expect(begun).toEqual(["a", "c"]);
    expect(slots.inFlight).toBe(0);
  });

  it("does not end a call that is running when its signal aborts, nor take the slot from one that waits", async () => {
    let slots = callSlots(1);
    let { begun, call, end } = calls();
    let request = new AbortController();
    let first = slots.of(0).run(request.signal, call("a"));
    let second = slots.of(0).run(NEVER, call("b"));
    await tick();
    request.abort(new Error("The text was cancelled."));
    await tick();
    // The call's own signal is what ends it: here it goes on, and still holds its slot.
    expect(begun).toEqual(["a"]);
    expect(slots.inFlight).toBe(1);
    end("a");
    expect(await first).toBe("a");
    await tick();
    expect(begun).toEqual(["a", "b"]);
    end("b");
    expect(await second).toBe("b");
    expect(slots.inFlight).toBe(0);
  });

  it("halves its limit at each refusal, never to under 1, and adds one for each answer, up to its capacity", () => {
    let slots = callSlots(9);
    let page = slots.of(0);
    let down: number[] = [];
    for (let refusal = 0; refusal < 5; refusal++) {
      page.refused();
      down.push(slots.limit);
    }
    expect(down).toEqual([4, 2, 1, 1, 1]);
    // Told by another page of the text: the limit is the text's.
    let up: number[] = [];
    for (let answer = 0; answer < 10; answer++) {
      slots.of(3).answered();
      up.push(slots.limit);
    }
    expect(up).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 9, 9]);
  });

  it("gives a call that waits the slot an answer adds", async () => {
    let slots = callSlots(2);
    let { begun, call, end } = calls();
    let page = slots.of(0);
    page.refused();
    let running = [page.run(NEVER, call("a")), page.run(NEVER, call("b"))];
    await tick();
    expect(begun).toEqual(["a"]);
    page.answered();
    await tick();
    expect(begun).toEqual(["a", "b"]);
    end("a");
    end("b");
    await Promise.all(running);
  });

  it("lets the calls that are running go on when its limit halves, and begins no other until fewer run than it", async () => {
    let slots = callSlots(4);
    let { begun, call, end } = calls();
    let page = slots.of(0);
    let running = ["a", "b", "c", "d", "e"].map(name => page.run(NEVER, call(name)));
    await tick();
    expect(begun).toEqual(["a", "b", "c", "d"]);

    page.refused();
    await tick();
    expect(slots).toMatchObject({ limit: 2, inFlight: 4 });
    // Three and then two still run, which is not fewer than two.
    end("a");
    await tick();
    end("b");
    await tick();
    expect(begun).toEqual(["a", "b", "c", "d"]);
    expect(slots.inFlight).toBe(2);
    end("c");
    await tick();
    expect(begun).toEqual(["a", "b", "c", "d", "e"]);
    end("d");
    end("e");
    expect(await Promise.all(running)).toEqual(["a", "b", "c", "d", "e"]);
    expect(slots.inFlight).toBe(0);
  });

  it("says when fewer calls wait for a slot than are asked about, and at once when that is so", async () => {
    let slots = callSlots(1);
    let { call, end } = calls();
    let running = ["a", "b", "c", "d"].map(name => slots.of(0).run(NEVER, call(name)));
    await tick();
    // One runs and three wait.
    let told: string[] = [];
    void slots.wanting(4, NEVER).then(() => told.push("under 4"));
    void slots.wanting(3, NEVER).then(() => told.push("under 3"));
    void slots.wanting(1, NEVER).then(() => told.push("under 1"));
    await tick();
    expect(told).toEqual(["under 4"]);
    end("a");
    await tick();
    expect(told).toEqual(["under 4", "under 3"]);
    end("b");
    await tick();
    expect(told).toEqual(["under 4", "under 3"]);
    end("c");
    await tick();
    expect(told).toEqual(["under 4", "under 3", "under 1"]);
    end("d");
    await Promise.all(running);
  });

  it("counts a call that rests after a refusal as one that waits, until its rest is over", async () => {
    let slots = callSlots(2);
    let page = slots.of(0);
    let rests = [0, 1].map(() => {
      let over!: () => void;
      let pause = new Promise<void>(resolve => { over = resolve; });
      return { over, rested: page.rest(pause) };
    });
    let told = false;
    void slots.wanting(2, NEVER).then(() => { told = true; });
    await tick();
    // Nothing waits for a slot, and two calls will: none is to be made on top of them.
    expect(told).toBe(false);
    rests[0]!.over();
    await tick();
    expect(told).toBe(true);
    // A rest that fails is over too.
    let failed = page.rest(Promise.reject(new Error("The page was given up.")));
    await expect(failed).rejects.toThrow("The page was given up.");
    await slots.wanting(2, NEVER);
    rests[1]!.over();
    await Promise.all(rests.map(({ rested }) => rested));
  });

  it("counts a wait that its signal ends as one fewer, and ends a wait to be told with its signal's reason", async () => {
    let slots = callSlots(1);
    let { call, end } = calls();
    let first = slots.of(0).run(NEVER, call("a"));
    let request = new AbortController();
    let given = slots.of(0).run(request.signal, call("b")).catch((error: unknown) => error);
    await tick();
    let told = false;
    void slots.wanting(1, NEVER).then(() => { told = true; });
    let asking = new AbortController();
    let ended = slots.wanting(1, asking.signal).catch((error: unknown) => error);
    let reason = new Error("The text was cancelled.");
    asking.abort(reason);
    expect(await ended).toBe(reason);
    expect(told).toBe(false);

    request.abort(reason);
    expect(await given).toBe(reason);
    await tick();
    expect(told).toBe(true);
    await expect(slots.wanting(1, AbortSignal.abort(reason))).rejects.toBe(reason);
    end("a");
    await first;
  });
});

describe("pixelRoom", () => {
  let limits = { ...READ_AHEAD };
  /** Every hold a test was given, let go at its end. */
  let holds: PixelHold[] = [];
  /** Ends the waits a test leaves behind. */
  let ending = new AbortController();

  beforeEach(() => {
    READ_AHEAD.isolateBytes = 150;
    holds = [];
    ending = new AbortController();
  });

  afterEach(() => {
    ending.abort(new Error("The test ended."));
    for (let hold of holds) hold.release();
    Object.assign(READ_AHEAD, limits);
    expect(pixelsHeld()).toBe(0);
    vi.useRealTimers();
  });

  /**
   * A hold asked of `room`, whether it has been given, and how often it was told that it waits
   * for the isolate's room: `given` is the hold once it has. A wait still outstanding at the
   * test's end is ended there.
   */
  function asked(room: ReturnType<typeof pixelRoom>, bytes: number, signal = ending.signal) {
    let ask: { given?: PixelHold; failed?: unknown; queued: number; done: Promise<void> } = {
      queued: 0,
      done: room.reserve(bytes, signal, () => { ask.queued++; }).then(hold => {
        holds.push(hold);
        ask.given = hold;
      }, error => { ask.failed = error; }),
    };
    return ask;
  }

  it("holds every text in the isolate to one budget between them, which none passes", async () => {
    let one = pixelRoom();
    let other = pixelRoom();
    let first = asked(one, 90);
    let second = asked(other, 60);
    // The isolate has no room for it, whichever text asks.
    let third = asked(other, 1);
    await tick();
    expect(first.given && second.given).toBeTruthy();
    expect(third.given).toBeUndefined();
    expect(pixelsHeld()).toBe(150);

    // What one text lets go is room for another.
    first.given!.release();
    await tick();
    expect(third.given).toBeDefined();
    expect(pixelsHeld()).toBe(61);
  });

  it("gives no text more than the isolate has, however many texts ask, and each its turn", async () => {
    let rooms = Array.from({ length: 8 }, () => pixelRoom());
    let asks = rooms.map(room => asked(room, 40));
    await tick();
    // Three of them fit, and the rest wait.
    expect(asks.map(ask => ask.given !== undefined)).toEqual([true, true, true, false, false, false, false, false]);
    expect(pixelsHeld()).toBe(120);
    // Each gets its turn as room is let go, and the isolate never holds more.
    for (let next = 3; next < asks.length; next++) {
      asks[next - 3]!.given!.release();
      await tick();
      expect(asks[next]!.given).toBeDefined();
      expect(pixelsHeld()).toBe(120);
    }
  });

  it("counts a hold as the bytes it was last resized to", async () => {
    let room = pixelRoom();
    let first = asked(room, 120);
    let second = asked(room, 50);
    await tick();
    expect(second.given).toBeUndefined();
    first.given!.resize(50);
    await tick();
    expect(second.given).toBeDefined();
    expect(pixelsHeld()).toBe(100);
    first.given!.resize(70);
    expect(pixelsHeld()).toBe(120);
    first.given!.release();
    expect(pixelsHeld()).toBe(50);
  });

  it("lets a hold go once, however often it is released, and does not resize it after", async () => {
    let room = pixelRoom();
    let first = asked(room, 60);
    let second = asked(room, 30);
    await tick();
    first.given!.release();
    first.given!.release();
    expect(pixelsHeld()).toBe(30);
    first.given!.resize(60);
    expect(pixelsHeld()).toBe(30);
    second.given!.release();
    expect(pixelsHeld()).toBe(0);
  });

  it("rejects a wait that its signal ends with the signal's reason, and holds nothing for it", async () => {
    let room = pixelRoom();
    let first = asked(room, 150);
    let request = new AbortController();
    let second = asked(room, 50, request.signal);
    await tick();
    let reason = new Error("The text was cancelled.");
    request.abort(reason);
    await second.done;
    expect(second.failed).toBe(reason);

    // Room that comes free later is not given to it.
    first.given!.release();
    await tick();
    expect(second.given).toBeUndefined();
    expect(pixelsHeld()).toBe(0);

    // Nor is anything held for a signal that had aborted before it asked, though there is room.
    let late = asked(room, 10, AbortSignal.abort(reason));
    await late.done;
    expect(late.failed).toBe(reason);
    expect(pixelsHeld()).toBe(0);
  });

  it("gives the isolate's room in the order it was asked for: a later hold that would fit waits behind one that does not", async () => {
    let [one, two, three] = [pixelRoom(), pixelRoom(), pixelRoom()];
    let first = asked(one, 100);
    let large = asked(two, 80);
    // There is room in the isolate for this one, and it was asked for after one that waits.
    let small = asked(three, 30);
    await tick();
    expect([large.given, small.given]).toEqual([undefined, undefined]);

    first.given!.release();
    await tick();
    expect(large.given && small.given).toBeTruthy();
    expect(pixelsHeld()).toBe(110);
  });

  it("gives the next in line the isolate's room when the wait before it ends", async () => {
    let [one, two, three] = [pixelRoom(), pixelRoom(), pixelRoom()];
    asked(one, 100);
    let request = new AbortController();
    let large = asked(two, 80, request.signal);
    let small = asked(three, 30);
    await tick();
    expect(small.given).toBeUndefined();
    request.abort(new Error("The text was cancelled."));
    await large.done;
    await tick();
    expect(small.given).toBeDefined();
    expect(pixelsHeld()).toBe(130);
  });

  it("tells a hold that waits for other texts alone that it does, every so often, and no other", async () => {
    vi.useFakeTimers();
    let settle = () => vi.advanceTimersByTimeAsync(0);
    let [one, two, three] = [pixelRoom(), pixelRoom(), pixelRoom()];
    let first = asked(one, 90);
    let second = asked(two, 40);
    await settle();
    // The isolate has no room for these. The first is of a text that holds pixels, which are what
    // moves that text or does not; the other two are of a text that holds none, one behind the other.
    let holding = asked(two, 30);
    let ahead = asked(three, 60);
    let behind = asked(three, 30);
    await settle();
    let waits = [holding, ahead, behind];
    expect(waits.map(wait => wait.given)).toEqual([undefined, undefined, undefined]);
    // Each wait has a timer of its own, which runs for as long as what waits does.
    expect(vi.getTimerCount()).toBe(3);

    await vi.advanceTimersByTimeAsync(READ_AHEAD.queuedMs - 1);
    expect(waits.map(wait => wait.queued)).toEqual([0, 0, 0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(waits.map(wait => wait.queued)).toEqual([0, 1, 1]);
    await vi.advanceTimersByTimeAsync(READ_AHEAD.queuedMs);
    expect(waits.map(wait => wait.queued)).toEqual([0, 2, 2]);

    // Given its room, a hold is told nothing more, and with nothing waiting there is no timer.
    first.given!.release();
    second.given!.release();
    await settle();
    expect(waits.every(wait => wait.given)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * READ_AHEAD.queuedMs);
    expect(waits.map(wait => wait.queued)).toEqual([0, 2, 2]);
  });

  it("takes back what a text that shows no life holds, so that the room is not lost for good", async () => {
    vi.useFakeTimers();
    let settle = () => vi.advanceTimersByTimeAsync(0);
    let abandoned: number[] = [];
    let gone = pixelRoom(bytes => abandoned.push(bytes));
    let living = pixelRoom();
    let waits = pixelRoom();
    // A text whose Durable Object was reset: nothing of it runs again to let its pixels go.
    let lost = asked(gone, 90);
    let kept = asked(living, 50);
    await settle();
    let ask = asked(waits, 40);
    await settle();
    expect(ask.given).toBeUndefined();

    // A text that lives says so: a page of its moves, or its reader asks for one.
    let steps = READ_AHEAD.abandonedMs / READ_AHEAD.queuedMs;
    for (let step = 0; step < steps; step++) {
      await vi.advanceTimersByTimeAsync(READ_AHEAD.queuedMs);
      living.moved();
      expect(ask.given).toBeUndefined();
    }
    await vi.advanceTimersByTimeAsync(READ_AHEAD.queuedMs);
    expect(abandoned).toEqual([90]);
    expect(ask.given).toBeDefined();
    expect(pixelsHeld()).toBe(90);

    // What was taken back is not counted again when its hold is let go after all.
    lost.given!.resize(10);
    lost.given!.release();
    expect(pixelsHeld()).toBe(90);
    kept.given!.release();
    expect(pixelsHeld()).toBe(40);
  });

  it("refuses a hold of more than the isolate may hold, which could never be given", async () => {
    let ask = asked(pixelRoom(), 151);
    await ask.done;
    expect(ask.failed).toBeInstanceOf(RangeError);
    expect(pixelsHeld()).toBe(0);
  });

  it("puts a wait that was taken for gone back in the line at its next tick", async () => {
    vi.useFakeTimers();
    let settle = () => vi.advanceTimersByTimeAsync(0);
    let [one, two] = [pixelRoom(), pixelRoom()];
    let first = asked(one, 100);
    await settle();
    let late = asked(two, 80);
    await settle();
    // Its timer is behind by more than three ticks when another's gives pixels, and then runs.
    vi.setSystemTime(Date.now() + 4 * READ_AHEAD.queuedMs);
    first.given!.resize(90);
    expect(late.given).toBeUndefined();
    await vi.advanceTimersByTimeAsync(READ_AHEAD.queuedMs);
    first.given!.release();
    await settle();
    expect(late.given).toBeDefined();
    expect(pixelsHeld()).toBe(80);
  });

  it("takes a wait out of the line once its own timer has stopped running", async () => {
    vi.useFakeTimers();
    let settle = () => vi.advanceTimersByTimeAsync(0);
    let [one, two, three] = [pixelRoom(), pixelRoom(), pixelRoom()];
    let first = asked(one, 100);
    await settle();
    // A wait of a Durable Object that is then reset: its timer is gone, and it is never ended.
    let timers = vi.getTimerCount();
    let dead = asked(two, 80);
    await settle();
    expect(vi.getTimerCount()).toBe(timers + 1);
    vi.clearAllTimers();
    // Behind it, a wait that fits the isolate as the dead one does not.
    let behind = asked(three, 30);
    await settle();
    expect(behind.given).toBeUndefined();

    for (let ticks = 0; ticks < 4; ticks++) {
      one.moved();
      await vi.advanceTimersByTimeAsync(READ_AHEAD.queuedMs);
    }
    expect(behind.given).toBeDefined();
    expect(dead.given).toBeUndefined();
    first.given!.release();
    await settle();
    expect(dead.given).toBeUndefined();
    expect(pixelsHeld()).toBe(30);
  });
});
