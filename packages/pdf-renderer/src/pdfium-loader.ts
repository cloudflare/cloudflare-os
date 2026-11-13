// Instantiates the PDFium build from its compiled module, with an import object written here: the
// build is given no file system, no clock and no output, its memory grows only through this file,
// which is where the cap on it is kept, and the bytes it has moved for it outside its own code
// are taken from its work counter here. Nothing here needs Node or a browser.

/** The build's exports, called by name, with its memory, its function table and its work counter. */
export type PdfiumExports = Record<string, (...args: number[]) => number> & {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
  /**
   * What is left of the work the instance may do: the build takes one from it at the start of
   * every function and of every pass of a loop, and ends the call it is in when it comes to zero.
   */
  work: WebAssembly.Global;
};

/** What an instance asked of its host and was refused. */
export type PdfiumHost = {
  /**
   * Times the memory was refused growth past its cap. PDFium ends itself on most refusals, but a
   * decoder refused memory may leave its image out and report nothing, so a call during which
   * this rose has not done what it says.
   */
  refusedGrowths: number;
  /** Whether the build called abort(), which it does when it cannot go on. */
  aborted: boolean;
  /**
   * File-system calls the build made, every one of which fails. It makes them only to look for a
   * font a page's text names and the file does not embed, and then draws with one of its own.
   */
  fileCalls: number;
};

/** One PDFium instance and what its host refused it. */
export type PdfiumInstance = {
  exports: PdfiumExports;
  host: PdfiumHost;
  /**
   * Takes from the work counter for `bytes` moved for the instance outside its code, where the
   * counter does not see them, and ends the call with a {@link PdfiumAbort} when that uses it up.
   */
  spend(bytes: number): void;
};

/** Thrown out of a call when PDFium ends itself, most often because the cap refused it memory. */
export class PdfiumAbort extends Error {}

const WASM_PAGE = 65536;
/** The most pieces of one write that are added up: the build's own writes have two. */
const MAX_IOVECS = 8;
/** Bytes moved outside the instance's code that count as one unit of its work. */
const BYTES_A_UNIT = 64;
const ENOENT = 44, EBADF = 8, ENOTTY = 59, ENODEV = 43, ESPIPE = 70;
/** What longjmp throws through WebAssembly frames; `invoke_*` catches it and sets the flag. */
const LONGJMP = Symbol("longjmp");

/**
 * Instantiates `module`, the PDFium build, with a memory that never passes `maxBytes`: a growth
 * past it is refused and counted, and one within it is of exactly what was asked. The build's
 * code holds no instruction that grows its memory or writes its function table, so the memory
 * grows only here. Every file-system call fails, what the build prints is dropped unread (it may
 * quote a document), and the time is always the epoch.
 */
export function instantiatePdfium(module: WebAssembly.Module, maxBytes: number): PdfiumInstance {
  let host: PdfiumHost = { refusedGrowths: 0, aborted: false, fileCalls: 0 };
  let exports!: PdfiumExports;
  let u8 = () => new Uint8Array(exports.memory.buffer);
  let u32 = () => new Uint32Array(exports.memory.buffer);
  let spend = (bytes: number) => {
    let left = (exports.work.value as number) - Math.ceil(bytes / BYTES_A_UNIT);
    exports.work.value = Math.max(0, left);
    if (left <= 0) throw new PdfiumAbort("PDFium ran out of work");
  };
  let fails = (errno: number) => () => {
    host.fileCalls++;
    return -errno;
  };
  let invoke = (index: number, ...args: number[]) => {
    let stack = exports.emscripten_stack_get_current!();
    try {
      return (exports.__indirect_function_table.get(index) as (...args: number[]) => number)(...args);
    } catch (error) {
      exports._emscripten_stack_restore!(stack);
      if (error !== LONGJMP) throw error;
      exports.setThrew!(1, 0);
      return 0;
    }
  };
  // A struct tm of the epoch: no rendering depends on the time.
  let epoch = (...args: (number | bigint)[]) => {
    let pointer = (typeof args[0] === "bigint" ? args[1] : args[2]) as number;
    new Int32Array(exports.memory.buffer, pointer, 9).set([0, 0, 0, 1, 0, 70, 4, 0, 0]);
  };
  let env: Record<string, (...args: never[]) => unknown> = {
    emscripten_resize_heap: (requested: number) => {
      requested >>>= 0;
      let current = exports.memory.buffer.byteLength;
      if (requested > maxBytes) {
        host.refusedGrowths++;
        return 0;
      }
      // What was asked and no more: the memory never shrinks, so nothing is taken on spec.
      try {
        exports.memory.grow(Math.ceil((requested - current) / WASM_PAGE));
        return 1;
      } catch {
        host.refusedGrowths++;
        return 0;
      }
    },
    _emscripten_memcpy_js: (to: number, from: number, length: number) => {
      spend(length >>> 0);
      u8().copyWithin(to, from, from + length);
    },
    _abort_js: () => {
      host.aborted = true;
      throw new PdfiumAbort("PDFium aborted");
    },
    emscripten_date_now: () => 0,
    _tzset_js: (timezone: number, daylight: number, standard: number, summer: number) => {
      let words = u32();
      words[timezone >> 2] = 0;
      words[daylight >> 2] = 0;
      for (let pointer of [standard, summer]) u8().set([85, 84, 67, 0], pointer);
    },
    _localtime_js: epoch as never,
    _gmtime_js: epoch as never,
    _emscripten_throw_longjmp: () => {
      throw LONGJMP;
    },
    emscripten_err: () => undefined,
    __syscall_openat: fails(ENOENT),
    __syscall_fcntl64: fails(EBADF),
    __syscall_ioctl: fails(ENOTTY),
    __syscall_fstat64: fails(EBADF),
    __syscall_stat64: fails(ENOENT),
    __syscall_newfstatat: fails(ENOENT),
    __syscall_lstat64: fails(ENOENT),
    __syscall_getdents64: fails(EBADF),
    __syscall_unlinkat: fails(ENOENT),
    __syscall_rmdir: fails(ENOENT),
    __syscall_ftruncate64: fails(EBADF),
    _mmap_js: fails(ENODEV),
    _munmap_js: fails(ENODEV),
  };
  for (let name of ["invoke_viii", "invoke_ii", "invoke_iii", "invoke_iiii", "invoke_iiiii"]) {
    env[name] = invoke as never;
  }
  let wasi: Record<string, (...args: never[]) => unknown> = {
    environ_sizes_get: (countPointer: number, sizePointer: number) => {
      let words = u32();
      words[countPointer >> 2] = 0;
      words[sizePointer >> 2] = 0;
      return 0;
    },
    environ_get: () => 0,
    fd_write: (_fd: number, iov: number, iovCount: number, written: number) => {
      let words = u32();
      let total = 0;
      for (let i = 0; i < Math.min(iovCount, MAX_IOVECS); i++) total += words[(iov >> 2) + i * 2 + 1]!;
      words[written >> 2] = total;
      return 0;
    },
    fd_read: () => {
      host.fileCalls++;
      return EBADF;
    },
    fd_close: () => 0,
    fd_sync: () => 0,
    fd_seek: () => {
      host.fileCalls++;
      return ESPIPE;
    },
  };
  let instance = new WebAssembly.Instance(module, { env, wasi_snapshot_preview1: wasi } as WebAssembly.Imports);
  exports = instance.exports as PdfiumExports;
  exports.__wasm_call_ctors!();
  return { exports, host, spend };
}
