// The operational-transform representation of uncommitted code changes.
//
// A chat's uncommitted state is a sequence of `CodeOp`s applied on top of committed gadget code
// (see ChatCodeBase in the API): every producer -- human keystrokes, agent tool edits,
// update-from-mainline merges -- expresses its change as an op against the chat content as of
// some revision, and the server serializes them into one revisioned stream per chat. An op
// carries no base content, only "a change relative to revision N", which is what lets it
// compose with git-backed storage (the base is always some commit's tree plus earlier ops).
//
// This module is the single owner of the op invariants: the wire types, application,
// composition, transformation, diffing, the ingestion validation, and the priority convention
// all live here and nowhere else. The text-OT core is `@codemirror/state`'s ChangeSet (the
// substrate of @codemirror/collab), and op generation uses `fast-diff`; both are private to
// this module -- not because they might be swapped out, but so the invariants stay in one
// place. The wire carries our own plain-JSON types (structurally ChangeSet's compact JSON
// form), keeping the RPC contract self-describing.
//
// Priority convention (fixed here, used identically on both sides of the wire): for two ops
// made concurrently against the same revision, *the op the server ordered earlier comes first*
// -- its inserts precede the later op's at equal positions. This is exactly ChangeSet's
// documented transform law: `A.compose(B.map(A))` and `B.compose(A.map(B, true))` produce the
// same document. `transformCodeOp(a, b)` bakes the pairing in; nothing else may call the
// underlying `map`.
//
// Trust boundary: ops from clients are validated in two stages, and the stages must stay in
// this order. `validateCodeOpSchema` runs *before* any transform -- transformation is
// structural and must only ever see well-formed ops -- while `validateCodeOpContent` runs
// *after* transforming the op to the server's current revision, because lengths and boundaries
// are only meaningful against the content the op will actually apply to.
//
// Validation's resource-exhaustion goal is deliberately modest: reject anything the caps rule
// out in at most one linear pass over input the RPC layer already parsed (with cheap early
// exits where they fall out naturally), and no more. Op producers hold edit rights, and a user
// who can edit the workspace can do far worse than burn the workspace server's CPU; the
// isolate memory limit bounds the blast radius. The size caps exist first for correctness --
// composed ops get stored and travel in RPC messages, both of which have hard size limits of
// their own -- not as a DoS defense, so don't grow this file chasing sub-linear rejection of
// every hostile shape.

import { ChangeSet, Text } from "@codemirror/state";
import fastDiff from "fast-diff";

// =======================================================================================
// Wire types

/**
 * A text edit: ChangeSet's compact JSON form. A `TextOp` is a sequence of sections covering the
 * *entire* original text -- a bare number retains that many UTF-16 code units, and
 * `[deletedLength, ...insertedLines]` replaces `deletedLength` units with the given lines
 * (joined by "\n"; a one-element array is a pure deletion). Because sections tile the whole
 * text, the op carries its exact before- and after-lengths by construction.
 *
 * Example: `[2, [2, "😀"], 3]` keeps 2 units, replaces the next 2 with "😀", and keeps the
 * final 3 -- valid only against a text of exactly 7 UTF-16 code units.
 */
export type TextOp = (number | [number, ...string[]])[];

/**
 * One file's part of a `CodeOp`. A file's state is a string or absent, and exactly one of the
 * three variants applies:
 * - `{edit}`: transform the existing text (invalid if the file is absent, or if its length
 *   doesn't match the op's before-length);
 * - `{set}`: create the file or wholesale-replace its content -- valid against any state,
 *   including absent;
 * - `{remove}`: delete the file. Valid against any state (deleting an absent file is a no-op),
 *   which keeps `remove` composable and transformable without knowing the base.
 */
export type FileOp = { edit: TextOp } | { set: string } | { remove: true };

/**
 * One code change: for each touched gadget, a list of `[path, FileOp]` entries. Keys of the
 * outer object are gadget ids (WorkpieceIds) in canonical decimal form; an empty object is the
 * identity op, and a present gadget entry must be a non-empty list with no duplicate paths.
 * Plain JSON, treated as immutable everywhere -- functions in this module share subtrees
 * between inputs and outputs rather than copying. Ops produced by this module list entries in
 * sorted path order, but consumers must not require that of received ops (entry order has no
 * meaning; only duplicates are illegal).
 *
 * The per-gadget entries are deliberately a list rather than a path-keyed object: paths may be
 * any non-empty string, including names that collide with `Object.prototype` members (git
 * content can legitimately contain a file named `__proto__` or `constructor`), and such names
 * must never be object keys on the wire -- Cap'n Web deletes prototype-shadowing keys (and
 * `toJSON`) from every object it deserializes, so a path-keyed map would silently lose those
 * files in RPC transit. Gadget ids are safe as keys precisely because the canonical-decimal
 * rule excludes every such name.
 */
export type CodeOp = { [gadgetId: string]: [path: string, op: FileOp][] };

// =======================================================================================
// Content model

/** One gadget's file contents: `path -> text`, the same flattened shape Overseer.getCodeAtCommit() returns. */
export type GadgetFiles = Map<string, string>;

/**
 * The code content of a chat (or any other collection of gadgets' files), keyed by gadget id.
 * Functions in this module treat content maps as immutable: `applyCodeOp` returns a new map that
 * shares the file maps of untouched gadgets with its input, so callers must never mutate one.
 */
export type CodeContent = Map<number, GadgetFiles>;

// =======================================================================================
// Size caps

/**
 * Maximum length, in UTF-16 code units, of a single file's text that an op may produce (a
 * `set`'s content or an `edit`'s after-length). Backstop, not a product limit: gadget files are
 * source code, and each must fit in a git storage record capped at 2MB -- 512K code units stays
 * under that even for incompressible worst-case UTF-8.
 */
export const MAX_FILE_TEXT_LENGTH = 512 * 1024;

/**
 * Maximum length, in UTF-16 code units, of a single file path within an op. Enforced only on
 * submitted ops (`validateCodeOpSchema`), so pre-existing or imported content with a longer
 * path is not itself invalidated -- it just can't be targeted by a new op until this constant
 * is raised. Far above any real gadget file path.
 */
export const MAX_FILE_PATH_LENGTH = 1024;

/**
 * Maximum total size of one `CodeOp`, measured as a proxy for its serialized size: each file
 * entry costs a fixed overhead plus its path length plus its payload -- a `set`'s content
 * length, or an `edit`'s weighted section count plus its inserted-text length (`remove` costs
 * nothing beyond the overhead). Counting entries and sections, not just inserted text, bounds
 * storage, RPC messages, and transform work even for ops made of many payload-free parts (mass
 * removes). Enforced by `validateCodeOpSchema`.
 */
export const MAX_CODE_OP_SIZE = 2 * 1024 * 1024;

// The two module-private weights behind MAX_CODE_OP_SIZE (callers only need the cap itself):
// the fixed per-file-entry share, and each edit section's share -- a section serializes to a
// few bytes of digits and brackets even when it inserts nothing, so it must weigh more than
// nothing but needn't be exact.
const FILE_ENTRY_SIZE_OVERHEAD = 16;
const EDIT_SECTION_SIZE_WEIGHT = 4;

// =======================================================================================
// Internal helpers

// Parses a (schema-valid) TextOp into a ChangeSet. fromJSON also throws on malformed input,
// making every consumer of an unvalidated op fail closed.
function toChangeSet(op: TextOp): ChangeSet {
  return ChangeSet.fromJSON(op);
}

// Text round-trips all line-separator exotica losslessly: only "\n" is treated as a line
// boundary, so "\r", "\r\n", "\u2028", "\u2029", and NUL stay inside their lines.
function applyTextOp(text: string, op: TextOp): string {
  return toChangeSet(op).apply(Text.of(text.split("\n"))).toString();
}

// Iterates a CodeOp's gadget entries as numeric ids. Assumes canonical keys (schema-validated
// or produced by this module).
function opGadgets(op: CodeOp): [number, [string, FileOp][]][] {
  return Object.entries(op).map(([key, value]) => [Number(key), value]);
}

// Builds a CodeOp with deterministic order (gadgets numeric ascending, entries by path),
// dropping empty gadget entries. Determinism matters because ops are stored and compared (e.g.
// the migration's conversion-determinism guarantee).
function makeCodeOp(gadgets: Map<number, Map<string, FileOp>>): CodeOp {
  let op: CodeOp = {};
  for (let gadgetId of [...gadgets.keys()].toSorted((x, y) => x - y)) {
    let files = gadgets.get(gadgetId)!;
    if (files.size === 0) continue;
    op[gadgetId] = [...files.keys()].toSorted().map(path => [path, files.get(path)!]);
  }
  return op;
}

// Pairs up two CodeOps' file entries: yields (gadgetId, path, a's FileOp | undefined,
// b's FileOp | undefined) over the union of paths.
function* pairedFileOps(a: CodeOp, b: CodeOp):
    Generator<[number, string, FileOp | undefined, FileOp | undefined]> {
  let toMaps = (op: CodeOp) => new Map(
      opGadgets(op).map(([id, entries]) => [id, new Map(entries)]));
  let aGadgets = toMaps(a);
  let bGadgets = toMaps(b);
  for (let gadgetId of new Set([...aGadgets.keys(), ...bGadgets.keys()])) {
    let aFiles = aGadgets.get(gadgetId) ?? new Map<string, FileOp>();
    let bFiles = bGadgets.get(gadgetId) ?? new Map<string, FileOp>();
    for (let path of new Set([...aFiles.keys(), ...bFiles.keys()])) {
      yield [gadgetId, path, aFiles.get(path), bFiles.get(path)];
    }
  }
}

// =======================================================================================
// Application

/**
 * Applies `op` to `content`, returning the resulting content. The input is not modified; the
 * result shares the file maps of untouched gadgets with it (treat both as immutable). A gadget
 * entry is created for any gadget the op touches. Throws if the op doesn't fit the content (an
 * `edit` of an absent file or of a file whose length doesn't match) -- ingestion paths must
 * have validated the op first, so a throw here indicates a bug.
 */
export function applyCodeOp(content: CodeContent, op: CodeOp): CodeContent {
  let result = new Map(content);
  for (let [gadgetId, fileOps] of opGadgets(op)) {
    let files = new Map(result.get(gadgetId));
    result.set(gadgetId, files);
    for (let [path, fileOp] of fileOps) {
      if ("set" in fileOp) {
        files.set(path, fileOp.set);
      } else if ("remove" in fileOp) {
        files.delete(path);
      } else {
        let existing = files.get(path);
        if (existing === undefined) {
          throw new Error(`edit of absent file: gadget ${gadgetId} ${path}`);
        }
        files.set(path, applyTextOp(existing, fileOp.edit));
      }
    }
  }
  return result;
}

// =======================================================================================
// Composition

/**
 * Composes two sequential ops into one with the same effect: `b` must apply to the content
 * produced by `a`, and `applyCodeOp(c, composeCodeOp(a, b))` equals
 * `applyCodeOp(applyCodeOp(c, a), b)`. Throws on ops that cannot be sequential (an `edit` after
 * a `remove`, or edits whose lengths don't chain) -- like `applyCodeOp`, a throw indicates a
 * bug in the caller, not bad client input.
 */
export function composeCodeOp(a: CodeOp, b: CodeOp): CodeOp {
  let gadgets = new Map<number, Map<string, FileOp>>();
  for (let [gadgetId, path, aOp, bOp] of pairedFileOps(a, b)) {
    let files = gadgets.get(gadgetId) ?? new Map<string, FileOp>();
    gadgets.set(gadgetId, files);
    files.set(path, composeFileOp(gadgetId, path, aOp, bOp));
  }
  return makeCodeOp(gadgets);
}

function composeFileOp(
    gadgetId: number, path: string, a: FileOp | undefined, b: FileOp | undefined): FileOp {
  if (a === undefined) return b!;
  if (b === undefined) return a;
  // b is later: its `set` or `remove` wholesale-supersedes whatever a did.
  if ("set" in b || "remove" in b) return b;
  // b is an edit of a's result.
  if ("set" in a) return { set: applyTextOp(a.set, b.edit) };
  if ("remove" in a) {
    throw new Error(`cannot compose edit after remove: gadget ${gadgetId} ${path}`);
  }
  return { edit: toChangeSet(a.edit).compose(toChangeSet(b.edit)).toJSON() };
}

// =======================================================================================
// Transformation

/**
 * The result of `transformCodeOp(a, b)`: each input op rebased to apply after the other, under
 * the fixed priority pairing. `a` is the original `a` transformed to apply after the original
 * `b`; `b` is the original `b` transformed to apply after the original `a`. Applying either
 * pairing to the same base -- original `a` then this `b`, or original `b` then this `a` --
 * produces identical content.
 */
export interface TransformedCodeOps {
  /** The earlier op, rebased to apply after the original `b`. Retains its priority. */
  a: CodeOp;

  /** The later op, rebased to apply after the original `a`. */
  b: CodeOp;
}

/**
 * Transforms two concurrent ops (both made against the same content) across each other. `a` is
 * the side the server ordered *earlier*, which fixes the priority convention: at equal
 * positions, `a`'s inserts precede `b`'s.
 *
 * Both sides of the wire use this one function. The server rebases an incoming op over the ops
 * already accepted since the op's claimed revision (each accepted op is `a`, the incoming op is
 * `b`); a client holding unacknowledged local edits rebases them over each incoming broadcast
 * op (the broadcast op is `a` -- the server accepted it first -- and the client updates its
 * display with the transformed `a` while keeping the transformed `b` as its new pending op).
 *
 * Per-path rules (`set` and `remove` behave alike, so these also cover delete-vs-edit and
 * create-vs-create):
 * - edit vs edit: delegated to the text OT core under the documented pairing;
 * - `set`/`remove` vs an opposing `edit`: the `set`/`remove` survives unchanged and the `edit`
 *   is dropped, regardless of order -- its base was wholesale-replaced, so there is nothing
 *   meaningful to rebase it onto;
 * - `set`/`remove` vs `set`/`remove`: last-writer-wins by server order -- `b` survives, `a` is
 *   dropped from the rebased result (it must not clobber `b` when applied after it).
 */
export function transformCodeOp(a: CodeOp, b: CodeOp): TransformedCodeOps {
  let aGadgets = new Map<number, Map<string, FileOp>>();
  let bGadgets = new Map<number, Map<string, FileOp>>();
  for (let [gadgetId, path, aOp, bOp] of pairedFileOps(a, b)) {
    let aFiles = aGadgets.get(gadgetId) ?? new Map<string, FileOp>();
    aGadgets.set(gadgetId, aFiles);
    let bFiles = bGadgets.get(gadgetId) ?? new Map<string, FileOp>();
    bGadgets.set(gadgetId, bFiles);

    if (aOp === undefined) {
      bFiles.set(path, bOp!);
    } else if (bOp === undefined) {
      aFiles.set(path, aOp);
    } else if ("edit" in aOp && "edit" in bOp) {
      let aSet = toChangeSet(aOp.edit);
      let bSet = toChangeSet(bOp.edit);
      aFiles.set(path, { edit: aSet.map(bSet, true).toJSON() });
      bFiles.set(path, { edit: bSet.map(aSet).toJSON() });
    } else if ("edit" in aOp) {
      // b's set/remove supersedes a's edit.
      bFiles.set(path, bOp);
    } else if ("edit" in bOp) {
      // a's set/remove wholesale-replaced b's base; b's edit is dropped.
      aFiles.set(path, aOp);
    } else {
      // Both set/remove: last-writer-wins by server order.
      bFiles.set(path, bOp);
    }
  }
  return { a: makeCodeOp(aGadgets), b: makeCodeOp(bGadgets) };
}

// =======================================================================================
// Diffing

/**
 * Computes the op that turns `before` into `after`:
 * `applyCodeOp(before, diffFiles(before, after))` equals `after`. Unchanged files contribute
 * nothing; added files become `set`, removed files `remove`, and changed files a minimal
 * character-level `edit` whose boundaries never split a UTF-16 surrogate pair. The result is
 * deterministic (same inputs, same op, same key and entry order), which the migration's conversion
 * messages rely on. Note a gadget with no files diffs identically to an absent gadget: ops
 * carry only file changes, so gadget existence is not represented.
 */
export function diffFiles(before: CodeContent, after: CodeContent): CodeOp {
  let gadgets = new Map<number, Map<string, FileOp>>();
  for (let gadgetId of new Set([...before.keys(), ...after.keys()])) {
    let beforeFiles = before.get(gadgetId) ?? new Map<string, string>();
    let afterFiles = after.get(gadgetId) ?? new Map<string, string>();
    let files = new Map<string, FileOp>();
    for (let path of new Set([...beforeFiles.keys(), ...afterFiles.keys()])) {
      let beforeText = beforeFiles.get(path);
      let afterText = afterFiles.get(path);
      if (beforeText === afterText) continue;
      if (afterText === undefined) {
        files.set(path, { remove: true });
      } else if (beforeText === undefined) {
        files.set(path, { set: afterText });
      } else {
        files.set(path, { edit: diffTextOp(beforeText, afterText) });
      }
    }
    gadgets.set(gadgetId, files);
  }
  return makeCodeOp(gadgets);
}

// Folds fast-diff's edit script ([kind, text] runs over the whole strings) into ChangeSet
// change specs in original coordinates, merging each adjacent delete/insert run into a single
// replacement. fast-diff never splits surrogate pairs (verified by fuzz tests), so the
// resulting boundaries always pass validateCodeOpContent.
function diffTextOp(before: string, after: string): TextOp {
  let specs: { from: number, to: number, insert?: string }[] = [];
  let diffs = fastDiff(before, after);
  let pos = 0;
  for (let i = 0; i < diffs.length; i++) {
    let [kind, text] = diffs[i];
    if (kind === fastDiff.EQUAL) {
      pos += text.length;
      continue;
    }
    // Pair a delete with an immediately following insert (or vice versa) as one replacement.
    let deleted = kind === fastDiff.DELETE ? text : "";
    let inserted = kind === fastDiff.INSERT ? text : "";
    let next = diffs[i + 1];
    if (next !== undefined && next[0] !== fastDiff.EQUAL && next[0] !== kind) {
      if (next[0] === fastDiff.DELETE) deleted = next[1];
      else inserted = next[1];
      i++;
    }
    specs.push({ from: pos, to: pos + deleted.length, insert: inserted });
    pos += deleted.length;
  }
  // The explicit "\n" line separator matters: ChangeSet.of's default splits inserted strings on
  // /\r\n?|\n/ and Text rejoins lines with "\n", which would corrupt content containing bare
  // "\r". Only "\n" is a line boundary here, matching splitLines' invariants in git-store.
  return ChangeSet.of(specs, before.length, "\n").toJSON();
}

/**
 * Builds the TextOp that replaces `replaced` -- the document's exact text at
 * `[from, from + replaced.length)` -- with `insert`, in a document of length `docLength`. The
 * producer-side alternative to diffing when the replaced span is already known (editFile matched
 * it): no diff is run. A match is often padded with unchanged context to disambiguate it, so the
 * common prefix and suffix of `replaced` and `insert` are trimmed -- never splitting a UTF-16
 * surrogate pair -- and the op reports only the text that actually changed. Equal `replaced` and
 * `insert` yield the identity op; an out-of-range span throws (`ChangeSet.of` rejects it at
 * construction).
 */
export function replaceSpanOp(
    docLength: number, from: number, replaced: string, insert: string): TextOp {
  let maxTrim = Math.min(replaced.length, insert.length);
  let pre = 0;
  while (pre < maxTrim && replaced.charCodeAt(pre) === insert.charCodeAt(pre)) pre++;
  // Back off a prefix ending on a high surrogate: the boundary could otherwise split a pair in
  // the document or in the insert. The prefix chars are equal in both strings, so one
  // (conservative) check covers both.
  if (pre > 0 && isHighSurrogate(replaced.charCodeAt(pre - 1))) pre--;
  let suf = 0;
  while (suf < maxTrim - pre && replaced.charCodeAt(replaced.length - 1 - suf) ===
      insert.charCodeAt(insert.length - 1 - suf)) {
    suf++;
  }
  // Likewise, back off a retained suffix starting on a low surrogate.
  if (suf > 0 && isLowSurrogate(replaced.charCodeAt(replaced.length - suf))) suf--;

  let trimmedInsert = insert.slice(pre, insert.length - suf);
  let spec = { from: from + pre, to: from + replaced.length - suf, insert: trimmedInsert };
  let specs = spec.from === spec.to && trimmedInsert === "" ? [] : [spec];
  // The explicit "\n" line separator: see diffTextOp above.
  return ChangeSet.of(specs, docLength, "\n").toJSON();
}

// =======================================================================================
// Inspection

/** The gadget ids an op touches, ascending. Empty for the identity op. */
export function changedGadgets(op: CodeOp): number[] {
  return Object.keys(op).map(Number).toSorted((a, b) => a - b);
}

// =======================================================================================
// Validation (the trust boundary)

/**
 * Stage 1 of ingestion validation: structural well-formedness, checked *before* any transform
 * (transformation must only ever see schema-valid ops). Verifies the outer shape (canonical
 * decimal gadget keys; non-empty entry lists of `[path, FileOp]` pairs with non-empty,
 * duplicate-free paths; exactly one variant per `FileOp`), that every `edit` parses as a
 * ChangeSet whose sections are non-negative integers that each retain, delete, or insert
 * something (do-nothing padding is rejected) and whose inserted line strings contain no "\n",
 * and the size caps: `MAX_FILE_TEXT_LENGTH` per produced file, `MAX_FILE_PATH_LENGTH` per
 * path, and `MAX_CODE_OP_SIZE` for the op overall. Throws on the first violation.
 * Content-dependent checks (lengths, boundaries) are stage 2: `validateCodeOpContent`.
 */
export function validateCodeOpSchema(op: CodeOp): void {
  if (typeof op !== "object" || op === null || Array.isArray(op)) {
    throw new Error("code op must be an object");
  }
  // The size cap is enforced as a running budget, not an after-the-fact sum: an edit's section
  // count is pre-checked in O(1) and the budget re-checked as each section's cost accrues, so a
  // hostile op is rejected before its sections are walked -- and in particular before
  // `ChangeSet.fromJSON` materializes a second copy of an oversized edit.
  let remaining = MAX_CODE_OP_SIZE;
  for (let [gadgetKey, fileOps] of Object.entries(op)) {
    let gadgetId = Number(gadgetKey);
    if (!Number.isSafeInteger(gadgetId) || gadgetId < 0 || String(gadgetId) !== gadgetKey) {
      throw new Error(`code op gadget key is not a canonical gadget id: ${gadgetKey}`);
    }
    if (!Array.isArray(fileOps)) {
      throw new Error(`code op gadget entry must be an array: gadget ${gadgetKey}`);
    }
    if (fileOps.length === 0) {
      throw new Error(`code op gadget entry is empty: gadget ${gadgetKey}`);
    }
    let seen = new Set<string>();
    for (let entry of fileOps) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
        throw new Error(`code op file entry must be a [path, op] pair: gadget ${gadgetKey}`);
      }
      let [path, fileOp] = entry;
      if (path === "") throw new Error(`code op file path is empty: gadget ${gadgetKey}`);
      if (path.length > MAX_FILE_PATH_LENGTH) {
        throw new Error(`code op file path is too long: gadget ${gadgetKey}`);
      }
      if (seen.has(path)) {
        throw new Error(`code op has a duplicate file entry: gadget ${gadgetKey} ${path}`);
      }
      seen.add(path);
      remaining -= FILE_ENTRY_SIZE_OVERHEAD + path.length;
      if (remaining < 0) throw new Error("code op is too large");
      remaining -= validateFileOpSchema(`gadget ${gadgetKey} ${path}`, fileOp, remaining);
    }
  }
}

// Validates one FileOp's schema, returning its payload's share of the op size (see
// MAX_CODE_OP_SIZE; always <= budget). Throws "code op is too large" as soon as the running
// cost exceeds `budget`, so an oversized payload is rejected without being fully walked.
function validateFileOpSchema(where: string, fileOp: FileOp, budget: number): number {
  if (typeof fileOp !== "object" || fileOp === null || Array.isArray(fileOp)) {
    throw new Error(`file op must be an object: ${where}`);
  }
  let keys = Object.keys(fileOp);
  if (keys.length !== 1 || !["edit", "set", "remove"].includes(keys[0])) {
    throw new Error(`file op must have exactly one of edit/set/remove: ${where}`);
  }
  if ("set" in fileOp) {
    if (typeof fileOp.set !== "string") throw new Error(`file op set must be a string: ${where}`);
    if (fileOp.set.length > MAX_FILE_TEXT_LENGTH) throw new Error(`file is too large: ${where}`);
    if (fileOp.set.length > budget) throw new Error("code op is too large");
    return fileOp.set.length;
  }
  if ("remove" in fileOp) {
    if (fileOp.remove !== true) throw new Error(`file op remove must be true: ${where}`);
    return 0;
  }
  // ChangeSet.fromJSON is not strict enough on its own -- it accepts negative and non-integer
  // section lengths, sections that neither retain, delete, nor insert (free padding that would
  // evade the size caps), and inserted "line" strings containing "\n" (which desynchronize the
  // resulting document's line metadata from its text) -- so check sections ourselves first;
  // fromJSON then rejects the remaining malformed shapes, on input the budget has bounded.
  if (!Array.isArray(fileOp.edit)) throw new Error(`file op edit must be an array: ${where}`);
  // O(1) budget pre-check on the section count alone, before any section is even looked at.
  let cost = fileOp.edit.length * EDIT_SECTION_SIZE_WEIGHT;
  if (cost > budget) throw new Error("code op is too large");
  for (let section of fileOp.edit) {
    if (Array.isArray(section)) {
      if (!Number.isSafeInteger(section[0]) || section[0] < 0) {
        throw new Error(`file op edit has an invalid section length: ${where}`);
      }
      // The inserted text's length: the lines' lengths plus the "\n" joining them. Non-string
      // entries fall through to fromJSON's rejection below. The separator count is known
      // before the lines are walked, so a section padded with empty lines is rejected here in
      // O(1) rather than after the walk.
      let insertedHere = section.length >= 2 ? section.length - 2 : 0;
      if (cost + insertedHere > budget) throw new Error("code op is too large");
      for (let i = 1; i < section.length; i++) {
        let line = section[i];
        if (typeof line !== "string") continue;
        if (line.includes("\n")) {
          throw new Error(`file op edit inserted line contains a newline: ${where}`);
        }
        insertedHere += line.length;
      }
      if (section[0] === 0 && insertedHere === 0) {
        throw new Error(`file op edit has a do-nothing section: ${where}`);
      }
      cost += insertedHere;
      if (cost > budget) throw new Error("code op is too large");
    } else {
      if (!Number.isSafeInteger(section) || section < 0) {
        throw new Error(`file op edit has an invalid section length: ${where}`);
      }
      if (section === 0) throw new Error(`file op edit has a do-nothing section: ${where}`);
    }
  }
  let changes: ChangeSet;
  try {
    changes = toChangeSet(fileOp.edit);
  } catch (e) {
    throw new Error(`file op edit is malformed: ${where}: ${e}`, { cause: e });
  }
  if (changes.newLength > MAX_FILE_TEXT_LENGTH) throw new Error(`file is too large: ${where}`);
  return cost;
}

/**
 * Stage 2 of ingestion validation: the op against the content it will actually apply to,
 * checked *after* transforming it to the server's current revision (and only on schema-valid
 * ops -- run `validateCodeOpSchema` first). Verifies each `edit` targets an existing file of
 * exactly the op's before-length, that every change boundary lands on a code-point boundary of
 * that file, and that no inserted or `set` text contains a lone UTF-16 surrogate. The surrogate
 * rules are what keep replicas byte-identical: ops travel as UTF-8 (where a lone surrogate
 * decodes as U+FFFD), so a mid-pair boundary or a lone surrogate would make remote replicas
 * disagree with the sender. Throws on the first violation.
 */
export function validateCodeOpContent(op: CodeOp, content: CodeContent): void {
  for (let [gadgetId, fileOps] of opGadgets(op)) {
    for (let [path, fileOp] of fileOps) {
      let where = `gadget ${gadgetId} ${path}`;
      if ("set" in fileOp) {
        if (hasLoneSurrogate(fileOp.set)) {
          throw new Error(`file op set contains a lone surrogate: ${where}`);
        }
      } else if ("edit" in fileOp) {
        let text = content.get(gadgetId)?.get(path);
        if (text === undefined) throw new Error(`edit of absent file: ${where}`);
        let changes = toChangeSet(fileOp.edit);
        if (changes.length !== text.length) {
          throw new Error(`file op edit length mismatch: ${where}: ` +
              `op expects ${changes.length}, file has ${text.length}`);
        }
        changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          if (!isCodePointBoundary(text, fromA) || !isCodePointBoundary(text, toA)) {
            throw new Error(`file op edit splits a surrogate pair: ${where}`);
          }
          if (hasLoneSurrogate(inserted.toString())) {
            throw new Error(`file op edit inserts a lone surrogate: ${where}`);
          }
        });
      }
      // `remove` needs no content checks: it is valid against any state.
    }
  }
}

// Whether position `pos` in `text` is a code-point boundary, i.e. does not fall between the
// halves of a surrogate pair.
function isCodePointBoundary(text: string, pos: number): boolean {
  if (pos <= 0 || pos >= text.length) return true;
  return !(isHighSurrogate(text.charCodeAt(pos - 1)) && isLowSurrogate(text.charCodeAt(pos)));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code < 0xdc00;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code < 0xe000;
}

// Whether `text` contains an unpaired UTF-16 surrogate half.
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (isHighSurrogate(code)) {
      if (i + 1 >= text.length || !isLowSurrogate(text.charCodeAt(i + 1))) return true;
      i++;  // Skip the low half of a well-formed pair.
    } else if (isLowSurrogate(code)) {
      return true;
    }
  }
  return false;
}
