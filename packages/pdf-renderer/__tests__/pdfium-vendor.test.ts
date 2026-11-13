/// <reference types="node" />

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { metered, unmetered } from "../scripts/pdfium-meter";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(PACKAGE_DIR, "src");
const VENDOR_DIR = join(PACKAGE_DIR, "vendor/pdfium");

/** The committed build: the upstream `pdfium.wasm` with the work counter added. */
const BUILD = { bytes: 5_817_418, sha256: "ad5d52ee9bd09e3a4a5fd81db397e9202b3c58049612530a24fdbcbf2a3ee10d" };
/** `lib/pdfium.wasm` of the release's archive, whose provenance the vendor README says how to verify. */
const UPSTREAM = { bytes: 5_585_328, sha256: "0a7f7ec0a395264fd6f4354ff9caabe2b36f64b7c6d1f492d6ff313d573c7378" };

/** The sha256 of each file taken from the release's archive as it is. */
const ARCHIVE_SHA256: Record<string, string> = {
  "LICENSE": "ba26c1263131696b86c10496b5066b918a20b7161822a80c274d0080105f6c93",
  "VERSION": "5a8a04893fa6b762d3826f5304249b75cf8f8044e3601eb102aa07bedc58df14",
  "args.gn": "bcbf4745d8268e198b9d1e100897bc631f7b86971491c603c61cf77211f8ee39",
  "licenses/abseil.txt": "c79a7fea0e3cac04cd43f20e7b648e5a0ff8fa5344e644b0ee09ca1162b62747",
  "licenses/agg23.txt": "c110d3ea2ad77467ce0dcff7d3337e6c8be8049a5103f4b9bd5fd911a77972e5",
  "licenses/dragonbox-Apache2-LLVM.txt": "9e45e856bedccee9f67254082ca11851d954de2fed7448c4bed19ad9aab99a91",
  "licenses/dragonbox-Boost.txt": "c9bff75738922193e67fa726fa225535870d2aa1059f91452c411736284ad566",
  "licenses/fast_float.txt": "e562f3f974ced7e69dd1db77b820b36bcf8f30377f1aa105723fba449c53c4e6",
  "licenses/freetype.txt": "f4b133e25df1f86ad3ffea453aa0e613f0474f34778dbbb3e437e7b2724937d8",
  "licenses/harfbuzz.txt": "ba8f810f2455c2f08e2d56bb49b72f37fcf68f1f4fade38977cfd7372050ad64",
  "licenses/highway.txt": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
  "licenses/icu.txt": "e55522d81edc687a341a4411e0776e54ca654e90147f354a90458aaced4116af",
  "licenses/lcms.txt": "7312b68c5b25e9bf2b828706fb4e29588f22705112f411fd42e1f7d84c3d139a",
  "licenses/libjpeg_turbo.ijg": "75815e3bf6484201a3c3d17a1bbf10f2e8e3237f84df10a2357ea896db2a81d6",
  "licenses/libjpeg_turbo.md": "96f5b328adbb78eeaaec6980d73fd558cb1e4d62560ed615646bc3cf5e532430",
  "licenses/libopenjpeg.txt": "c5ab0890a737c2dfa7ba675036554f6d17741d98629b0c2a145354d00617e6b2",
  "licenses/libpng.txt": "bdb0a645ea18c60507d0368379b1ac5474b92255fcc2d115e07486a7672ba526",
  "licenses/pdfium.txt": "961eacd9633fff6d051db7208b755e9210e30efac7adec3e6a6d52798f0ccf0e",
  "licenses/simdutf.txt": "fc8dbc04e03ad4efc08a647ffe7f995b811a95bc04c0e85a56d5277c6593fa5f",
  "licenses/zlib.txt": "33fd641c9f3b0e0be64bc78fea9e94807674cdd70c48477599226cb8956565fe",
};
/**
 * The sha256 of each notice the archive lacks for code that is in the build: Brotli's, musl's and
 * Emscripten's licences, and OpenJPEG's with every copyright holder.
 */
const ADDED_SHA256: Record<string, string> = {
  "licenses/brotli.txt": "3d180008e36922a4e8daec11c34c7af264fed5962d07924aea928c38e8663c94",
  "licenses/emscripten.txt": "620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86",
  "licenses/musl.txt": "f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af",
  "licenses/openjpeg.txt": "a6af136f3e15038a666b61f376612a07d9a4e48cb7c01adbf3e33b3f14ab49b6",
};
/** How `NOTICES.txt` begins: what the build is, how it differs from upstream's, and whose work it holds. */
const NOTICES_OPENING = [
  "Notices for the PDFium build in pdfium-metered.wasm and for everything linked into it. The build",
  "is pdfium.wasm of pdfium-binaries chromium/8138 with a work counter added at the start of every",
  "function and of every loop; nothing else of it is changed. This software is based in part on the",
  "work of the Independent JPEG Group. This software is based in part on the work of the FreeType",
  "Team.",
];

/** Everything the build asks of its host, in the order it imports them: functions, all of them. */
const BUILD_IMPORTS = [
  "env.emscripten_resize_heap", "env._emscripten_memcpy_js", "env._abort_js", "env.emscripten_date_now",
  "env._tzset_js", "wasi_snapshot_preview1.environ_sizes_get", "wasi_snapshot_preview1.environ_get",
  "env.__syscall_openat", "env.__syscall_fcntl64", "env.__syscall_ioctl", "wasi_snapshot_preview1.fd_write",
  "wasi_snapshot_preview1.fd_read", "wasi_snapshot_preview1.fd_close", "env.emscripten_err",
  "env.__syscall_fstat64", "env.__syscall_stat64", "env.__syscall_newfstatat", "env.__syscall_lstat64",
  "env._emscripten_throw_longjmp", "env.invoke_viii", "env.invoke_ii", "env.invoke_iii", "env.invoke_iiii",
  "env.__syscall_getdents64", "env.invoke_iiiii", "env.__syscall_unlinkat", "env.__syscall_rmdir",
  "wasi_snapshot_preview1.fd_sync", "env._localtime_js", "env._gmtime_js", "wasi_snapshot_preview1.fd_seek",
  "env._munmap_js", "env._mmap_js", "env.__syscall_ftruncate64",
];

/** The counter's instructions where global `counter` is the counter. */
function tick(counter: number): number[] {
  // global.get, i32.const 1, i32.sub, global.set, global.get, i32.eqz, if, unreachable, end
  return [0x23, counter, 0x41, 0x01, 0x6b, 0x24, counter, 0x23, counter, 0x45, 0x04, 0x40, 0x00, 0x0b];
}

/**
 * A module of 62 bytes with one mutable global and one exported function that loops as many
 * times as it is asked and says how many it made:
 *
 *     (func (export "run") (param i32) (result i32) (local i32)
 *       loop  local.get 1  i32.const 1  i32.add  local.tee 1  local.get 0  i32.lt_u  br_if 0  end
 *       local.get 1)
 */
const LOOPING = [
  [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
  [0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f],
  [0x03, 0x02, 0x01, 0x00],
  [0x06, 0x06, 0x01, 0x7f, 0x01, 0x41, 0x00, 0x0b],
  [0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x00],
  [
    0x0a, 0x17, 0x01, 0x15, 0x01, 0x01, 0x7f, 0x03, 0x40, 0x20, 0x01, 0x41, 0x01, 0x6a, 0x22, 0x01, 0x20, 0x00,
    0x49, 0x0d, 0x00, 0x0b, 0x20, 0x01, 0x0b,
  ],
];
/** An import section that imports a global, `e.g`, an immutable i32. */
const GLOBAL_IMPORT = [0x02, 0x08, 0x01, 0x01, 0x65, 0x01, 0x67, 0x03, 0x7f, 0x00];

/**
 * The thunks: `e.r` of type `(i32, i32, i32, i32) -> i32` and `e.p` of type `(i32) -> i32`,
 * imported and exported again as `r` and `p`.
 */
const THUNKS = [
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x0e, 0x02, 0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f, 0x60, 0x01, 0x7f, 0x01, 0x7f,
  0x02, 0x0d, 0x02, 0x01, 0x65, 0x01, 0x72, 0x00, 0x00, 0x01, 0x65, 0x01, 0x70, 0x00, 0x01,
  0x07, 0x09, 0x02, 0x01, 0x72, 0x00, 0x00, 0x01, 0x70, 0x00, 0x01,
];

/** Reads text that must be UTF-8, and leaves every byte of it in what it gives. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function vendored(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(VENDOR_DIR, name)));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function same(first: Uint8Array, second: Uint8Array): boolean {
  return Buffer.compare(first, second) === 0;
}

/** `bytes` compiled. The Worker's types give a module no constructor, since workerd compiles none from bytes. */
function compiled(bytes: Uint8Array): WebAssembly.Module {
  return Reflect.construct(WebAssembly.Module, [bytes]) as WebAssembly.Module;
}

/** Where `sequence` begins in `bytes`, every time it is there. */
function found(bytes: Uint8Array, sequence: number[]): number[] {
  let places: number[] = [];
  for (let at = bytes.indexOf(sequence[0]!); at >= 0; at = bytes.indexOf(sequence[0]!, at + 1)) {
    if (sequence.every((byte, i) => bytes[at + i] === byte)) places.push(at);
  }
  return places;
}

/** What a module is besides its code's arithmetic: what it defines, and what its code can reach. */
type ModuleState = {
  /** Function bodies, each read to exactly its end. */
  bodies: number;
  /** How often each instruction that can write a table, or grow or move memory in bulk, occurs. */
  instructions: Record<string, number>;
  /** The globals the module defines, in order. */
  globals: { mutable: boolean }[];
  tables: number;
  memories: number;
  /** What the module exports that is not a function. */
  exported: { name: string; kind: "table" | "memory" | "global"; index: number }[];
};

/**
 * Reads a module's sections and every instruction of every function body, without running
 * anything. Throws on an instruction it does not follow and on a body that does not end where
 * its length says.
 */
function moduleState(bytes: Uint8Array): ModuleState {
  let at = 8;
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
  let state: ModuleState = {
    bodies: 0,
    instructions: {
      "table.set": 0, "table.grow": 0, "table.fill": 0, "table.copy": 0, "table.init": 0,
      "memory.grow": 0, "memory.copy": 0, "memory.fill": 0,
    },
    globals: [], tables: 0, memories: 0, exported: [],
  };
  let count = (name: string) => {
    state.instructions[name]!++;
  };
  let body = (end: number) => {
    for (let groups = leb(); groups > 0; groups--) {
      skipLeb();
      at++;
    }
    while (at < end) {
      let op = bytes[at++]!;
      if (op === 0x02 || op === 0x03 || op === 0x04) {
        skipLeb();
      } else if (op === 0x0c || op === 0x0d || op === 0x10 || op === 0x12 || op === 0xd2) {
        skipLeb();
      } else if (op === 0x0e) {
        for (let n = leb(); n >= 0; n--) skipLeb();
      } else if (op === 0x11 || op === 0x13) {
        skipLeb();
        skipLeb();
      } else if (op === 0x1c) {
        for (let n = leb(); n > 0; n--) at++;
      } else if (op >= 0x20 && op <= 0x25) {
        skipLeb();
      } else if (op === 0x26) {
        skipLeb();
        count("table.set");
      } else if (op >= 0x28 && op <= 0x3e) {
        skipLeb();
        skipLeb();
      } else if (op === 0x3f) {
        at++;
      } else if (op === 0x40) {
        at++;
        count("memory.grow");
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
        } else if (sub === 9 || sub === 13 || sub === 16) {
          skipLeb();
        } else if (sub === 10) {
          at += 2;
          count("memory.copy");
        } else if (sub === 11) {
          at++;
          count("memory.fill");
        } else if (sub === 12) {
          skipLeb();
          skipLeb();
          count("table.init");
        } else if (sub === 14) {
          skipLeb();
          skipLeb();
          count("table.copy");
        } else if (sub === 15) {
          skipLeb();
          count("table.grow");
        } else if (sub === 17) {
          skipLeb();
          count("table.fill");
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
    state.bodies++;
  };
  while (at < bytes.length) {
    let id = bytes[at++]!, size = leb();
    let end = at + size;
    if (id === 4) state.tables = leb();
    if (id === 5) state.memories = leb();
    if (id === 6) {
      for (let n = leb(); n > 0; n--) {
        at++;
        let mutable = bytes[at++] === 1;
        // The value it begins with: a constant, here always an i32's, and `end`.
        if (bytes[at++] !== 0x41) throw new Error(`a global that does not begin as an i32 constant, at ${at}`);
        skipLeb();
        if (bytes[at++] !== 0x0b) throw new Error(`a global's first value is more than a constant, at ${at}`);
        state.globals.push({ mutable });
      }
    }
    if (id === 7) {
      for (let n = leb(); n > 0; n--) {
        let length = leb();
        let name = new TextDecoder().decode(bytes.subarray(at, at + length));
        at += length;
        let kind = bytes[at++]!, index = leb();
        if (kind !== 0) state.exported.push({ name, kind: (["table", "memory", "global"] as const)[kind - 1]!, index });
      }
    }
    if (id === 10) {
      for (let n = leb(); n > 0; n--) {
        let length = leb();
        body(at + length);
      }
    }
    at = end;
  }
  return state;
}

/**
 * `NOTICES.txt` as its sources make it: the opening, then `LICENSE` and every file of `licenses/`
 * in the byte order of their names, each under its name with a blank line after it. Every text is
 * UTF-8 but FreeType's, which is ISO-8859-1, so that the whole is UTF-8.
 */
function notices(): string {
  let names = ["LICENSE", ...readdirSync(join(VENDOR_DIR, "licenses")).toSorted().map(name => `licenses/${name}`)];
  let parts = names.map(name => {
    let bytes = vendored(name);
    let text = name === "licenses/freetype.txt"
      ? Array.from(bytes, byte => String.fromCharCode(byte)).join("")
      : UTF8.decode(bytes);
    return `==== ${name} ====\n${text}${text.endsWith("\n") ? "" : "\n"}\n`;
  });
  return `${NOTICES_OPENING.join("\n")}\n\n${parts.join("")}`;
}

describe("the vendored PDFium build", () => {
  let build = vendored("pdfium-metered.wasm");

  it("is the pinned file", () => {
    expect(build.byteLength).toBe(BUILD.bytes);
    expect(sha256(build)).toBe(BUILD.sha256);
  });

  it("is the upstream build and the counter, at every function's start and every loop's start, and nothing else", () => {
    let upstream = unmetered(build);
    expect(upstream.byteLength).toBe(UPSTREAM.bytes);
    expect(sha256(upstream)).toBe(UPSTREAM.sha256);
    expect(same(metered(upstream), build)).toBe(true);
  });

  it("is not taken for counted when one counter does nothing", () => {
    let place = found(build, tick(2))[4999]!;
    let broken = new Uint8Array(build);
    // The same length, so that every size in the module stays right: fourteen `nop`s.
    broken.fill(0x01, place, place + 14);
    expect(() => compiled(broken)).not.toThrow();
    expect(() => unmetered(broken)).toThrow(`no work counter at ${place}`);
  });

  it("holds what restoring an instance by its memory, and counting the bytes the host moves for it, rest on", () => {
    let state = moduleState(build);
    expect(state.bodies).toBe(6686);
    // The code writes no table, never grows the memory, and moves no bytes in bulk by itself.
    expect(state.instructions).toEqual({
      "table.set": 0, "table.grow": 0, "table.fill": 0, "table.copy": 0, "table.init": 0,
      "memory.grow": 0, "memory.copy": 0, "memory.fill": 0,
    });
    // Three globals, all its own and all mutable, of which only the last, the counter, is exported.
    expect(state.globals).toEqual([{ mutable: true }, { mutable: true }, { mutable: true }]);
    expect(state.tables).toBe(1);
    expect(state.memories).toBe(1);
    expect(state.exported).toEqual([
      { name: "memory", kind: "memory", index: 0 },
      { name: "__indirect_function_table", kind: "table", index: 0 },
      { name: "work", kind: "global", index: 2 },
    ]);
    // Nothing but functions is imported: no global, table or memory comes from outside.
    let imports = WebAssembly.Module.imports(compiled(build));
    expect(imports.map(entry => entry.kind)).toEqual(BUILD_IMPORTS.map(() => "function"));
    expect(imports.map(entry => `${entry.module}.${entry.name}`)).toEqual(BUILD_IMPORTS);
    expect(BUILD_IMPORTS).toHaveLength(34);
  });
});

describe("the work counter", () => {
  let looping = Uint8Array.from(LOOPING.flat());
  let counted = metered(looping);

  it("is put at a function's start and at a loop's start, and taken out again", () => {
    expect(looping.byteLength).toBe(62);
    expect(counted.byteLength).toBe(106);
    let places = found(counted, tick(1));
    expect(places).toHaveLength(2);
    // After the function's one local, and after the loop and its block type.
    expect([...counted.subarray(places[0]! - 3, places[0])]).toEqual([0x01, 0x01, 0x7f]);
    expect([...counted.subarray(places[1]! - 2, places[1])]).toEqual([0x03, 0x40]);
    expect(WebAssembly.Module.exports(compiled(counted))).toEqual([
      { name: "run", kind: "function" }, { name: "work", kind: "global" },
    ]);
    expect([...unmetered(counted)]).toEqual([...looping]);
  });

  it("ends a call when it comes to zero, and not before", () => {
    let { run, work } = new WebAssembly.Instance(compiled(counted)).exports as {
      run: (passes: number) => number; work: WebAssembly.Global;
    };
    // One for the function's start and one a pass.
    work.value = 12;
    expect(run(10)).toBe(10);
    expect(work.value).toBe(1);
    for (let allowed of [11, 3]) {
      work.value = allowed;
      expect(() => run(10)).toThrow(WebAssembly.RuntimeError);
      expect(work.value).toBe(0);
    }
  });

  it("is not added to a module that has it, which would export it twice", () => {
    expect(() => metered(counted)).toThrow("has the work counter already");
    expect(() => metered(vendored("pdfium-metered.wasm"))).toThrow("has the work counter already");
  });

  it("is not added to a module that exports nothing, and is not taken for counted when it is not exported", () => {
    let unexporting = Uint8Array.from([...LOOPING.slice(0, 4), ...LOOPING.slice(5)].flat());
    expect(WebAssembly.validate(unexporting)).toBe(true);
    expect(() => metered(unexporting)).toThrow("exports nothing");
    // The counted module without its export section, which is sixteen bytes: the counter is at
    // every place and is the last global, and nothing outside can set it.
    let exports = found(counted, [0x07, 0x0e, 0x02, 0x03, 0x72, 0x75, 0x6e]);
    expect(exports).toHaveLength(1);
    let unexported = Uint8Array.from([...counted.subarray(0, exports[0]), ...counted.subarray(exports[0]! + 16)]);
    expect(WebAssembly.validate(unexported)).toBe(true);
    expect(() => unmetered(unexported)).toThrow("the last export is not the work counter");
  });

  it("is not added to a module that imports a global", () => {
    let importing = Uint8Array.from([...LOOPING.slice(0, 2), GLOBAL_IMPORT, ...LOOPING.slice(2)].flat());
    expect(WebAssembly.validate(importing)).toBe(true);
    expect(() => metered(importing)).toThrow("imports something that is not a function");
  });
});

describe("the thunks", () => {
  it("are the 50 bytes that import two functions and export them again", () => {
    let thunks = new Uint8Array(readFileSync(join(SOURCE_DIR, "pdfium-thunks.wasm")));
    expect([...thunks]).toEqual(THUNKS);
    expect(thunks.byteLength).toBe(50);
  });

  it("make two JavaScript functions into functions a table holds", () => {
    let seen: number[][] = [];
    let module = compiled(Uint8Array.from(THUNKS));
    expect(WebAssembly.Module.exports(module)).toEqual([{ name: "r", kind: "function" }, { name: "p", kind: "function" }]);
    let { r, p } = new WebAssembly.Instance(module, {
      e: {
        r: (...args: number[]) => {
          seen.push(args);
          return 7;
        },
        p: (...args: number[]) => {
          seen.push(args);
          return 1;
        },
      },
    }).exports;
    let table = new WebAssembly.Table({ element: "anyfunc", initial: 2 });
    table.set(0, r);
    table.set(1, p);
    expect(table.get(0)(1, 2, 3, 4)).toBe(7);
    expect(table.get(1)(9)).toBe(1);
    expect(seen).toEqual([[1, 2, 3, 4], [9]]);
  });
});

describe("the vendored notices", () => {
  it("are the archive's files, unchanged, and the four it lacks", () => {
    let names = readdirSync(join(VENDOR_DIR, "licenses")).toSorted();
    expect(names).toEqual([
      "abseil.txt", "agg23.txt", "brotli.txt", "dragonbox-Apache2-LLVM.txt", "dragonbox-Boost.txt",
      "emscripten.txt", "fast_float.txt", "freetype.txt", "harfbuzz.txt", "highway.txt", "icu.txt", "lcms.txt",
      "libjpeg_turbo.ijg", "libjpeg_turbo.md", "libopenjpeg.txt", "libpng.txt", "musl.txt", "openjpeg.txt",
      "pdfium.txt", "simdutf.txt", "zlib.txt",
    ]);
    let pinned = { ...ARCHIVE_SHA256, ...ADDED_SHA256 };
    expect(Object.keys(pinned).filter(name => name.startsWith("licenses/")).toSorted())
      .toEqual(names.map(name => `licenses/${name}`));
    expect(Object.fromEntries(Object.keys(pinned).map(name => [name, sha256(vendored(name))]))).toEqual(pinned);
  });

  it("are gathered in NOTICES.txt, which says what was changed in the build", () => {
    let text = UTF8.decode(vendored("NOTICES.txt"));
    expect(text).toBe(notices());
    expect(text.startsWith("Notices for the PDFium build in pdfium-metered.wasm")).toBe(true);
    expect(text).toContain("with a work counter added");
  });
});

describe("the sources", () => {
  let sources = readdirSync(SOURCE_DIR).filter(name => name.endsWith(".ts"))
    .map(name => ({ name, text: readFileSync(join(SOURCE_DIR, name), "utf8") }));
  let source = (name: string) => sources.find(file => file.name === name)!.text;

  it("name the binaries in pdfium-module.ts alone, each in a dynamic import", () => {
    expect(sources.filter(({ text }) => /\.wasm["'`?]/.test(text)).map(({ name }) => name)).toEqual(["pdfium-module.ts"]);
    expect([...source("pdfium-module.ts").matchAll(/\bimport\(([^)]*)\)/g)].map(match => match[1])).toEqual([
      '"../vendor/pdfium/pdfium-metered.wasm"', '"./pdfium-thunks.wasm"',
    ]);
  });

  it("import the notices in worker.ts, which is what puts them in the bundle that carries the build", () => {
    expect(sources.filter(({ text }) => text.includes("NOTICES.txt")).map(({ name }) => name)).toEqual(["worker.ts"]);
    expect(source("worker.ts")).toContain('\nimport "../vendor/pdfium/NOTICES.txt";\n');
  });
});
