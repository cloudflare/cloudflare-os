// Adds a work counter to a WebAssembly module without changing what it computes: one more
// global, exported as "work", and at the start of every function and of every loop the
// instructions that take one from it and end the instance's call when it comes to zero. Every
// path through the code that can run for long passes a loop's start or a function's start again
// and again, so the host bounds a call into the module by the number it puts in the counter
// before it, whatever the module is made to do. No function, type, table or memory index moves,
// so everything else in the module is byte for byte what it was.

/**
 * `bytes`, a WebAssembly module, with the work counter added. Throws for a module that has the
 * counter already, and for one that exports nothing: the counter's export is added to its others.
 */
export function metered(bytes: Uint8Array): Uint8Array {
  return rewritten(bytes, true);
}

/**
 * `bytes`, a module that {@link metered} made, with the work counter taken out again: the module
 * it was made from, byte for byte. Throws when the counter is not at the start of every function
 * and of every loop, or is not the module's last global and last export, so that a module this
 * gives back to its known hash is known to count all of its work.
 */
export function unmetered(bytes: Uint8Array): Uint8Array {
  return rewritten(bytes, false);
}

/** Bytes of the module's header: its magic number and its version. */
const HEADER_BYTES = 8;
/** The sections that are read: every other one is copied as it is. */
const IMPORTS = 2, GLOBALS = 6, EXPORTS = 7, CODE = 10;

/** `value`, a count or a size, as the module writes it: seven bits a byte, the lowest first. */
function uleb(value: number): number[] {
  let out: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    out.push(value ? byte | 0x80 : byte);
  } while (value);
  return out;
}

/** The export of global `index` as "work", as the module writes it. */
function exportOf(index: number): number[] {
  return [4, 0x77, 0x6f, 0x72, 0x6b, 0x03, index];
}

/**
 * `bytes` with the counter put in (`add`) or taken out. Every instruction of every function body
 * is read to the body's end, since a loop's start is found only by following what comes before
 * it, and one this does not follow (a vector or atomic instruction) is refused. So is a module
 * that imports anything but functions: a global it imported would be numbered before its own,
 * and the counter is found by being the one after those. So are a module without a global or an
 * export of its own, whose sections the counter's are added to, and one to add the counter to
 * that has it already.
 */
function rewritten(bytes: Uint8Array, add: boolean): Uint8Array {
  let at = HEADER_BYTES;
  let leb = (): number => {
    let value = 0, shift = 0, byte: number;
    do {
      byte = bytes[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  let skipLeb = () => {
    while (bytes[at++]! & 0x80) { /* to the number's last byte */ }
  };

  // How many globals the module defines: the counter is the one after them, or the last of them.
  let globals = -1;
  let exporting = false;
  while (at < bytes.length) {
    let id = bytes[at++]!, size = leb();
    let end = at + size;
    if (id === IMPORTS) {
      for (let n = leb(); n > 0; n--) {
        for (let name = 0; name < 2; name++) {
          let length = leb();
          at += length;
        }
        if (bytes[at++] !== 0) throw new Error("the module imports something that is not a function");
        skipLeb();
      }
    }
    if (id === GLOBALS) globals = leb();
    if (id === EXPORTS) exporting = true;
    at = end;
  }
  let counter = add ? globals : globals - 1;
  if (counter < 1 || counter > 126) {
    throw new Error("the module has no global of its own, or too many for an index of one byte");
  }
  // global.get, i32.const 1, i32.sub, global.set, global.get, i32.eqz, if, unreachable, end
  let tick = [0x23, counter, 0x41, 0x01, 0x6b, 0x24, counter, 0x23, counter, 0x45, 0x04, 0x40, 0x00, 0x0b];
  // A mutable i32 that begins at the most it can hold, and its export as "work".
  let global = [0x7f, 0x01, 0x41, 0xff, 0xff, 0xff, 0xff, 0x07, 0x0b];
  let exported = exportOf(counter);
  let ends = (end: number, tail: number[]) => tail.every((byte, i) => bytes[end - tail.length + i] === byte);
  if (!exporting) {
    throw new Error(add ? "the module exports nothing for the work counter to be exported after" : "the last export is not the work counter");
  }

  /** Passes the counter at `at` when it is being taken out, and fails when it is not there. */
  let ticked = () => {
    if (add) return;
    if (!tick.every((byte, i) => bytes[at + i] === byte)) throw new Error(`no work counter at ${at}`);
    at += tick.length;
  };
  /** One function body, from its locals to `end`, with the counter put in or taken out. */
  let body = (end: number): number[] => {
    let from = at;
    /** Where a counter goes or was: where it starts, and where what follows it starts. */
    let places: [number, number][] = [];
    let place = () => {
      let start = at;
      ticked();
      places.push([start, at]);
    };
    for (let groups = leb(); groups > 0; groups--) {
      skipLeb();
      at++;
    }
    place();
    while (at < end) {
      let op = bytes[at++]!;
      if (op === 0x03) {
        // loop: its block type, then the counter.
        skipLeb();
        place();
      } else if (op === 0x02 || op === 0x04) {
        skipLeb();
      } else if (op === 0x0c || op === 0x0d || op === 0x10 || op === 0x12 || op === 0xd2) {
        skipLeb();
      } else if (op === 0x0e) {
        // br_table: its labels and the default one.
        for (let n = leb(); n >= 0; n--) skipLeb();
      } else if (op === 0x11 || op === 0x13) {
        skipLeb();
        skipLeb();
      } else if (op === 0x1c) {
        for (let n = leb(); n > 0; n--) at++;
      } else if (op >= 0x20 && op <= 0x26) {
        skipLeb();
      } else if (op >= 0x28 && op <= 0x3e) {
        skipLeb();
        skipLeb();
      } else if (op === 0x3f || op === 0x40) {
        at++;
      } else if (op === 0x41 || op === 0x42) {
        skipLeb();
      } else if (op === 0x43) {
        at += 4;
      } else if (op === 0x44) {
        at += 8;
      } else if (op === 0xd0) {
        at++;
      } else if (op === 0xfc) {
        let sub = leb();
        if (sub <= 7) {
          // A saturating conversion: nothing follows it.
        } else if (sub === 8) {
          skipLeb();
          at++;
        } else if (sub === 10) {
          at += 2;
        } else if (sub === 11) {
          at++;
        } else if (sub === 12 || sub === 14) {
          skipLeb();
          skipLeb();
        } else if (sub === 9 || sub === 13 || (sub >= 15 && sub <= 17)) {
          skipLeb();
        } else {
          throw new Error(`an instruction this does not follow, 0xfc ${sub}, at ${at}`);
        }
      } else if (
        (op >= 0x45 && op <= 0xc4) || op <= 0x01 || op === 0x05 || op === 0x0b || op === 0x0f ||
        op === 0x1a || op === 0x1b || op === 0xd1
      ) {
        // Nothing follows it.
      } else {
        throw new Error(`an instruction this does not follow, 0x${op.toString(16)}, at ${at}`);
      }
    }
    if (at !== end) throw new Error(`a function body was misread: it ended at ${at}, not ${end}`);
    let out: number[] = [];
    let copied = from;
    for (let [start, after] of places) {
      for (let i = copied; i < start; i++) out.push(bytes[i]!);
      if (add) out.push(...tick);
      copied = after;
    }
    for (let i = copied; i < end; i++) out.push(bytes[i]!);
    return out;
  };

  let parts: Uint8Array[] = [bytes.subarray(0, HEADER_BYTES)];
  let section = (id: number, content: number[]) => {
    parts.push(Uint8Array.from([id, ...uleb(content.length)]), Uint8Array.from(content));
  };
  at = HEADER_BYTES;
  while (at < bytes.length) {
    let start = at;
    let id = bytes[at++]!, size = leb();
    let end = at + size;
    if (id === GLOBALS || id === EXPORTS) {
      let tail = id === GLOBALS ? global : exported;
      let count = leb();
      if (!add && !ends(end, tail)) {
        throw new Error(`the last ${id === GLOBALS ? "global" : "export"} is not the work counter`);
      }
      if (add && id === EXPORTS && ends(end, exportOf(counter - 1))) {
        throw new Error("the module has the work counter already");
      }
      section(id, add
        ? [...uleb(count + 1), ...bytes.subarray(at, end), ...tail]
        : [...uleb(count - 1), ...bytes.subarray(at, end - tail.length)]);
    } else if (id === CODE) {
      let count = leb();
      let out: number[] = uleb(count);
      for (let n = count; n > 0; n--) {
        let length = leb();
        let made = body(at + length);
        for (let byte of uleb(made.length)) out.push(byte);
        for (let byte of made) out.push(byte);
      }
      section(CODE, out);
    } else {
      parts.push(bytes.subarray(start, end));
    }
    at = end;
  }
  let result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (let part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
