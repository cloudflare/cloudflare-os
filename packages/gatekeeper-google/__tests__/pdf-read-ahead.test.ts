import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});

describe("pixelRoom", () => {
  let limits = { ...READ_AHEAD };
  /** Every hold a test was given, let go at its end. */
  let holds: PixelHold[] = [];
  /** Ends the waits a test leaves behind. */
  let ending = new AbortController();

  beforeEach(() => {
    Object.assign(READ_AHEAD, { textBytes: 100, isolateBytes: 150 });
    holds = [];
    ending = new AbortController();
  });

  afterEach(() => {
    ending.abort(new Error("The test ended."));
    for (let hold of holds) hold.release();
    Object.assign(READ_AHEAD, limits);
    expect(pixelsHeld()).toBe(0);
  });

  /**
   * A hold asked of `room`, and whether it has been given: `given` is the hold once it has. A
   * wait still outstanding at the test's end is ended there.
   */
  function asked(
    room: ReturnType<typeof pixelRoom>, bytes: number, waitedFor = () => false, signal = ending.signal,
  ) {
    let ask: { given?: PixelHold; failed?: unknown; done: Promise<void> } = {
      done: room.reserve(bytes, signal, waitedFor).then(hold => {
        holds.push(hold);
        ask.given = hold;
      }, error => { ask.failed = error; }),
    };
    return ask;
  }

  it("holds a text to its budget, and gives a hold that waits once there is room", async () => {
    let room = pixelRoom();
    let first = asked(room, 60);
    // As many bytes as are left.
    let second = asked(room, 40);
    let third = asked(room, 1);
    await tick();
    expect(first.given && second.given).toBeTruthy();
    expect(third.given).toBeUndefined();
    expect(pixelsHeld()).toBe(100);

    first.given!.release();
    await tick();
    expect(third.given).toBeDefined();
    expect(pixelsHeld()).toBe(41);
  });

  it("holds every text in the isolate to one budget between them", async () => {
    let one = pixelRoom();
    let other = pixelRoom();
    let first = asked(one, 90);
    let second = asked(other, 60);
    // The other text has room for it, and the isolate has not.
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

  it("counts a hold as the bytes it was last resized to", async () => {
    let room = pixelRoom();
    let first = asked(room, 90);
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

  it("gives a hold its reader waits for at once, over the text's budget and the isolate's", async () => {
    let room = pixelRoom();
    let other = pixelRoom();
    asked(room, 100);
    asked(other, 50);
    let waitedFor = asked(room, 80, () => true);
    let ahead = asked(room, 80);
    await tick();
    expect(waitedFor.given).toBeDefined();
    expect(ahead.given).toBeUndefined();
    expect(pixelsHeld()).toBe(230);
  });

  it("looks at who waits again when told to, and not before", async () => {
    let room = pixelRoom();
    asked(room, 100);
    let reached = false;
    let ahead = asked(room, 80, () => reached);
    await tick();
    reached = true;
    await tick();
    expect(ahead.given).toBeUndefined();
    room.recheck();
    await tick();
    expect(ahead.given).toBeDefined();
    expect(pixelsHeld()).toBe(180);
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
    let first = asked(room, 100);
    let request = new AbortController();
    let second = asked(room, 50, () => false, request.signal);
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
    let late = asked(room, 10, () => true, AbortSignal.abort(reason));
    await late.done;
    expect(late.failed).toBe(reason);
    expect(pixelsHeld()).toBe(0);
  });

  it("gives those waiting in the order they asked, and passes over one that does not fit for a later one that does", async () => {
    let room = pixelRoom();
    let first = asked(room, 60);
    let large = asked(room, 50);
    // Asked after one that waits, and given before it: there is room for this one.
    let small = asked(room, 30);
    await tick();
    expect(large.given).toBeUndefined();
    expect(small.given).toBeDefined();

    // Of two that wait for the same room, the first to ask is given it.
    let later = asked(room, 50);
    await tick();
    first.given!.release();
    await tick();
    expect(large.given).toBeDefined();
    expect(later.given).toBeUndefined();
    expect(pixelsHeld()).toBe(80);
  });
});
