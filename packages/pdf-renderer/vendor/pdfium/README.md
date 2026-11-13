# PDFium, as WebAssembly

`pdfium-metered.wasm` is [PDFium](https://pdfium.googlesource.com/pdfium/), Chrome's PDF engine,
compiled to WebAssembly. The renderer Worker draws the pages of a PDF with it, in grey, for
whoever opens one through its binding. `src/pdfium-module.ts` is the one file that imports it.

It is the `lib/pdfium.wasm` of the `pdfium-wasm.tgz` asset of
[bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries) release
`chromium/8138`, **with a work counter added to it** and nothing else of it changed.

| | |
|---|---|
| PDFium | 159.0.8138.0, branch `chromium/8138`, commit `5f092b52993bfd98f94f04deff391918fe0fdcfd` |
| pdfium-binaries | release `chromium/8138`, commit `0eb94b28c2252d2baae3dfe15dc6b237131d8cd8`, built with Emscripten 3.1.72 by its `build-all.yml` workflow on a GitHub-hosted runner |
| `pdfium-wasm.tgz` | sha256 `68180bceda9c8feb825eb1e970215912bdda89c97331f5c768899d7406cb81f9` |
| `lib/pdfium.wasm` in it | 5,585,328 bytes, sha256 `0a7f7ec0a395264fd6f4354ff9caabe2b36f64b7c6d1f492d6ff313d573c7378` |
| `pdfium-metered.wasm` here | 5,817,418 bytes, sha256 `ad5d52ee9bd09e3a4a5fd81db397e9202b3c58049612530a24fdbcbf2a3ee10d` |

The upstream file itself is not kept here. `__tests__/pdfium-vendor.test.ts` takes the counter
out of `pdfium-metered.wasm` and holds what is left to the upstream file's sha256, so the one
binary in the tree is shown to be the release's build and the counter, and nothing more.

## What is in this directory

| File | What |
|---|---|
| `pdfium-metered.wasm` | the build, made by `scripts/meter-pdfium.ts` from the release's `lib/pdfium.wasm` |
| `LICENSE` | pdfium-binaries' own licence (MIT), for its build scripts and patches; from the archive |
| `VERSION`, `args.gn` | the PDFium version and the build's arguments (no V8, no XFA); from the archive |
| `licenses/` | the archive's 17 licence files, unchanged, and four it lacks (below) |
| `NOTICES.txt` | `LICENSE` and every file of `licenses/` as one text, which `src/worker.ts` imports so that the bundle that carries the build carries its notices |

`src/pdfium-thunks.wasm`, beside the module that imports it, is not PDFium's: it is 50 bytes
written for this package, through which PDFium calls two JavaScript functions.

## The work counter

A call into WebAssembly cannot be interrupted, and inside a Worker the clock does not advance
while one runs, so nothing outside the build can end a render that a hostile PDF has made long.
The build therefore counts its own work. `scripts/pdfium-meter.ts` adds to the module:

- one global, a mutable `i32`, after the module's own and exported as `work`;
- at the start of every function and of every loop, fourteen bytes of instructions that take one
  from that global and end the call (`unreachable`) when it comes to zero:
  `global.get`, `i32.const 1`, `i32.sub`, `global.set`, `global.get`, `i32.eqz`, `if`,
  `unreachable`, `end`.

Anything that runs for long passes a function's start or a loop's start again and again, so the
renderer bounds each call by the number it puts in `work` before it. No function, type, table or
memory index moves, the module imports what it imported, and every other section is byte for
byte the upstream's: 16,563 counters (6,686 functions and 9,877 loops), 232,090 bytes.

Taking the counter out again (`unmetered()` in the same file) checks, at every function's start
and every loop's start, that the fourteen bytes are there, and that the last global and the last
export are the counter's. A file it gives back to the upstream sha256 is therefore known to count
at every place.

## Verifying the release, and making the build

Nothing in the archive is run at any step: its files are hashed, read and copied.

1. Download the asset:

   ```
   gh release download chromium/8138 -R bblanchon/pdfium-binaries -p pdfium-wasm.tgz
   shasum -a 256 pdfium-wasm.tgz
   ```

2. Verify its build provenance, which ties the archive to the workflow, commit and run that
   built it:

   ```
   gh attestation verify pdfium-wasm.tgz --repo bblanchon/pdfium-binaries \
     --signer-workflow bblanchon/pdfium-binaries/.github/workflows/build-all.yml \
     --source-ref refs/heads/master --deny-self-hosted-runners
   ```

3. Verify that it is the asset of the release, which is immutable:

   ```
   gh release verify-asset chromium/8138 pdfium-wasm.tgz -R bblanchon/pdfium-binaries
   ```

4. Extract it without running anything, and compare the files with the hashes above and with
   the ones `__tests__/pdfium-vendor.test.ts` records for `LICENSE`, `VERSION`, `args.gn` and
   each file of `licenses/`:

   ```
   mkdir pdfium-wasm && tar -xzf pdfium-wasm.tgz -C pdfium-wasm
   (cd pdfium-wasm && shasum -a 256 lib/pdfium.wasm LICENSE VERSION args.gn licenses/*)
   ```

5. Check the notices against what was compiled. The release's licence step only warns about a
   library it does not know, and knows nothing of what Emscripten links in, so read the log of
   the WebAssembly job of the run that built the archive (step 2 gives its URL with
   `--format json`; for `chromium/8138` it is run 41803647331): every `Unknown library` warning,
   and every compiled object (`obj/third_party/<library>/…`), must be a component in the table
   below with a file in `licenses/`. GitHub keeps a run's log for a limited time, so this is done
   when the release is taken.

   ```
   gh run view <run id> -R bblanchon/pdfium-binaries --log > build.log
   grep -n "Unknown library" build.log
   grep -o "obj/third_party/[^/]*" build.log | sort | uniq -c
   ```

Then make the build from the verified file:

```
node scripts/meter-pdfium.ts pdfium-wasm/lib/pdfium.wasm
```

The script refuses a file whose sha256 is not the one it pins, writes `pdfium-metered.wasm` here
and prints its size and sha256.

What this does not establish: the attestation names the workflow, commit and run that produced
the archive, not the PDFium commit, which is known from the release's branch (`chromium/8138` has
one head and no commit of its own beyond PDFium's main branch); the build has not been reproduced
bit for bit, and upstream does not claim that it can be.

## What the build holds, and under which licences

| Component | Licence | Notice |
|---|---|---|
| PDFium, with its own JBIG2, fax and LZW decoders and its built-in fonts | BSD-3-Clause and Apache-2.0 | `licenses/pdfium.txt` |
| ICU (`icuuc`, no data file) | Unicode-3.0 | `licenses/icu.txt` |
| Abseil | Apache-2.0 | `licenses/abseil.txt` |
| libjpeg-turbo | IJG and BSD-3-Clause | `licenses/libjpeg_turbo.ijg`, `licenses/libjpeg_turbo.md` |
| HarfBuzz | Old MIT | `licenses/harfbuzz.txt` |
| Little CMS | MIT | `licenses/lcms.txt` |
| OpenJPEG | BSD-2-Clause | `licenses/openjpeg.txt`, `licenses/libopenjpeg.txt` |
| FreeType | FreeType License (FTL) | `licenses/freetype.txt` |
| zlib | Zlib | `licenses/zlib.txt` |
| Brotli (linked in, and left off by the renderer) | MIT | `licenses/brotli.txt` |
| Highway | Apache-2.0 | `licenses/highway.txt` |
| Anti-Grain Geometry 2.3 | the AGG 2.3 permission notice | `licenses/agg23.txt` |
| dragonbox | Apache-2.0 WITH LLVM-exception, or BSL-1.0 | `licenses/dragonbox-Apache2-LLVM.txt`, `licenses/dragonbox-Boost.txt` |
| fast_float | MIT | `licenses/fast_float.txt` |
| The Emscripten runtime: musl libc, Emscripten's own code, libc++, libc++abi, compiler-rt, dlmalloc | musl: MIT. Emscripten: MIT or NCSA. libc++, libc++abi and compiler-rt: Apache-2.0 WITH LLVM-exception, which asks for no notice of code that compiling embeds. dlmalloc: CC0 | `licenses/musl.txt`, `licenses/emscripten.txt` |

No component is under a copyleft licence. FreeType is offered under the FTL or the GPLv2, and
the FTL is the one taken.

Four texts are not in the release's archive and were added, each from the revision the build
used:

- `licenses/brotli.txt`: Brotli is compiled into this PDFium revision, and the release's licence
  step does not know it.
- `licenses/musl.txt` and `licenses/emscripten.txt`: Emscripten links its runtime in after the
  step that collects licences has read the build's own dependencies.
- `licenses/openjpeg.txt`: OpenJPEG's own `LICENSE`, with all of its copyright holders. The
  archive's `licenses/libopenjpeg.txt` is the header of one source file and names three of them.

`licenses/libpng.txt` and `licenses/simdutf.txt` describe code that is not in the binary. They
are kept so that the directory holds the archive's files as they are.

This software is based in part on the work of the Independent JPEG Group.

This software is based in part on the work of the FreeType Team.

The work counter is a change to the binary, and it is said where the licences ask for a change
to be said: here, and in the first lines of `NOTICES.txt`.

## Updating

When: a Chrome stable release note names a PDFium CVE in a decoder or in the renderer, or once
a quarter, whichever comes first. A vendored file is seen by no dependency tool, so nothing else
prompts it. pdfium-binaries publishes a release of PDFium's latest `chromium/NNNN` branch every
week.

How:

1. Repeat the five steps above for the release to take, the fifth included: a library that
   release has added needs its licence text in `licenses/`, a row in the table and a mention
   here if the archive lacks it.
2. Copy the archive's `LICENSE`, `VERSION`, `args.gn` and `licenses/` over the ones here, keeping
   the four added texts, each fetched again from the revision that release builds from.
3. Change the upstream sha256 that `scripts/meter-pdfium.ts` pins, run it, and change the
   sizes and hashes in `__tests__/pdfium-vendor.test.ts` and in this file, and the release's name
   in this file and in the first lines of `NOTICES.txt`.
4. Rebuild `NOTICES.txt`: its first lines, a blank line, then `LICENSE` and every file of
   `licenses/` in the byte order of their names, each as a line `==== <name> ====`, the file's
   text (as UTF-8; `licenses/freetype.txt` is ISO-8859-1 and is converted), and a blank line.
5. Run `__tests__/pdfium-vendor.test.ts`. Beyond the hashes, it reads the binary for the facts
   the renderer rests on when it puts an instance's memory back after every call (the build's
   code writes no table and never grows its memory, its globals are the stack pointer,
   Emscripten's scratch word and the counter, and it imports the 34 functions the loader gives
   it). A build that differs in any of them fails there, and the renderer has to be read against
   it before the test is changed.
6. Run `__tests__/pdf-render.test.ts`, whose work limits are counts of this build's work: a
   build that counts a page differently may need them measured again.

Each update adds about 2.5 MB to the repository's history.
