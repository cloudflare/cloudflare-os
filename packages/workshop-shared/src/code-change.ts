// The operational-transform representation of uncommitted code changes.
//
// A chat's uncommitted state is a sequence of `CodeChange`s applied on top of committed gadget
// code (see ChatCodeBase in the API): every producer -- human keystrokes, agent tool edits,
// update-from-mainline merges -- expresses its change against the chat content as of some
// revision, and the server serializes them into one revisioned stream per chat. A change
// carries no base content, only "a change relative to revision N", which is what lets it
// compose with git-backed storage (the base is always some commit's tree plus earlier changes).
//
// This module is the single owner of the code-change invariants: the wire types, application,
// composition, transformation, diffing, the ingestion validation, and the priority convention
// all live here and nowhere else. The text-OT core is `@codemirror/state`'s ChangeSet (the
// substrate of @codemirror/collab), and change generation uses `fast-diff`; both are private to
// this module -- not because they might be swapped out, but so the invariants stay in one
// place. The wire carries our own plain-JSON types (structurally ChangeSet's compact JSON
// form), keeping the RPC contract self-describing.
//
// Priority convention (fixed here, used identically on both sides of the wire): for two changes
// made concurrently against the same revision, *the change the server ordered earlier comes
// first* -- its inserts precede the later change's at equal positions. This is exactly
// ChangeSet's documented transform law: `A.compose(B.map(A))` and `B.compose(A.map(B, true))`
// produce the same document. `transformCodeChange(a, b)` bakes the pairing in; nothing else may
// call the underlying `map`.
//
// Trust boundary: changes from clients are validated in two stages, and the stages must stay in
// this order. `validateCodeChangeSchema` runs *before* any transform -- transformation is
// structural and must only ever see well-formed changes -- while `validateCodeChangeContent`
// runs *after* transforming the change to the server's current revision, because lengths and
// boundaries are only meaningful against the content the change will actually apply to.
//
// Both stages take a `CodeChange`, and that parameter type is a precondition rather than a
// hope: the declared shape is established before they run, by capnweb-validate's generated
// validator at the RPC edge (Overseer.submitCodeChange) and by the compiler for the one
// in-process producer (the agent's AgentHooks.appendAgentCodeChange, whose changes this module
// itself builds). So neither stage re-checks that a value is an object, an array, a pair, or a
// string; they check the invariants a TypeScript type cannot express -- canonical gadget keys,
// path rules, size caps, integer section lengths, and the one variant rule the wire validator's
// first-match union misses (see validateFileChangeSchema).
//
// Validation's resource-exhaustion goal is deliberately modest: reject anything the caps rule
// out in at most one linear pass over input the RPC layer already parsed (with cheap early
// exits where they fall out naturally), and no more. Change producers hold edit rights, and a
// user who can edit the workspace can do far worse than burn the workspace server's CPU; the
// isolate memory limit bounds the blast radius. The size caps exist first for correctness --
// composed changes get stored and travel in RPC messages, both of which have hard size limits
// of their own -- not as a DoS defense, so don't grow this file chasing sub-linear rejection of
// every hostile shape.

import { ChangeSet, Text } from "@codemirror/state";
import fastDiff from "fast-diff";

// =======================================================================================
// Wire types

/**
 * A text edit: ChangeSet's compact JSON form. A `TextChange` is a sequence of sections covering
 * the *entire* original text -- a bare number retains that many UTF-16 code units, and
 * `[deletedLength, ...insertedLines]` replaces `deletedLength` units with the given lines
 * (joined by "\n"; a one-element array is a pure deletion). Because sections tile the whole
 * text, the change carries its exact before- and after-lengths by construction.
 *
 * Example: `[2, [2, "😀"], 3]` keeps 2 units, replaces the next 2 with "😀", and keeps the
 * final 3 -- valid only against a text of exactly 7 UTF-16 code units.
 */
export type TextChange = (number | [number, ...string[]])[];

/**
 * One file's part of a `CodeChange`. A file's state is a string or absent, and exactly one of
 * the three variants applies:
 * - `{edit}`: transform the existing text (invalid if the file is absent, or if its length
 *   doesn't match the change's before-length);
 * - `{set}`: create the file or wholesale-replace its content -- valid against any state,
 *   including absent;
 * - `{remove}`: delete the file. Valid against any state (deleting an absent file is a no-op),
 *   which keeps `remove` composable and transformable without knowing the base.
 */
export type FileChange = { edit: TextChange } | { set: string } | { remove: true };

/**
 * One code change: for each touched gadget, a list of `[path, FileChange]` entries. Keys of the
 * outer object are gadget ids (WorkpieceIds) in canonical decimal form; an empty object is the
 * identity change, and a present gadget entry must be a non-empty list with no duplicate paths.
 * The index signature is `number`, but object keys are strings at runtime and on the wire, so
 * canonical decimal form is an invariant `validateCodeChangeSchema` enforces rather than one the
 * type states -- and iteration still yields string keys (see `gadgetEntries`).
 * Plain JSON, treated as immutable everywhere -- functions in this module share subtrees
 * between inputs and outputs rather than copying. Changes produced by this module list entries
 * in sorted path order, but consumers must not require that of received changes (entry order has
 * no meaning; only duplicates are illegal).
 *
 * The per-gadget entries are deliberately a list rather than a path-keyed object: paths may be
 * any non-empty string, including names that collide with `Object.prototype` members (git
 * content can legitimately contain a file named `__proto__` or `constructor`), and such names
 * must never be object keys on the wire -- Cap'n Web deletes prototype-shadowing keys (and
 * `toJSON`) from every object it deserializes, so a path-keyed map would silently lose those
 * files in RPC transit. Gadget ids are safe as keys precisely because the canonical-decimal
 * rule excludes every such name.
 */
export type CodeChange = { [gadgetId: number]: [path: string, change: FileChange][] };

// =======================================================================================
// Content model

/**
 * One gadget's file contents: `path -> text`, the same flattened shape
 * Overseer.getCodeAtCommit() returns.
 */
export type GadgetFiles = Map<string, string>;

/**
 * The code content of a chat (or any other collection of gadgets' files), keyed by gadget id.
 * Functions in this module treat content maps as immutable: `applyCodeChange` returns a new map
 * that shares the file maps of untouched gadgets with its input, so callers must never mutate one.
 */
export type CodeContent = Map<number, GadgetFiles>;

// =======================================================================================
// Size caps

/**
 * Maximum length, in UTF-16 code units, of a single file's text that a change may produce (a
 * `set`'s content or an `edit`'s after-length). Backstop, not a product limit: gadget files are
 * source code, and each must fit in a git storage record capped at 2MB -- 512K code units stays
 * under that even for incompressible worst-case UTF-8.
 */
export const MAX_FILE_TEXT_LENGTH = 512 * 1024;

/**
 * Maximum length, in UTF-16 code units, of a single file path within a change. Enforced only on
 * submitted changes (`validateCodeChangeSchema`), so pre-existing or imported content with a
 * longer path is not itself invalidated -- it just can't be targeted by a new change until this
 * constant is raised. Far above any real gadget file path.
 */
export const MAX_FILE_PATH_LENGTH = 1024;

/**
 * Maximum total size of one `CodeChange`, measured as a proxy for its serialized size: each file
 * entry costs a fixed overhead plus its path length plus its payload -- a `set`'s content
 * length, or an `edit`'s weighted section count plus its inserted-text length (`remove` costs
 * nothing beyond the overhead). Counting entries and sections, not just inserted text, bounds
 * storage, RPC messages, and transform work even for changes made of many payload-free parts
 * (mass removes). Enforced by `validateCodeChangeSchema`.
 */
export const MAX_CODE_CHANGE_SIZE = 2 * 1024 * 1024;

// The two module-private weights behind MAX_CODE_CHANGE_SIZE (callers only need the cap itself):
// the fixed per-file-entry share, and each edit section's share -- a section serializes to a
// few bytes of digits and brackets even when it inserts nothing, so it must weigh more than
// nothing but needn't be exact.
const FILE_ENTRY_SIZE_OVERHEAD = 16;
const EDIT_SECTION_SIZE_WEIGHT = 4;

// =======================================================================================
// Internal helpers

// Parses a (schema-valid) TextChange into a ChangeSet. fromJSON also throws on malformed input,
// making every consumer of an unvalidated change fail closed.
function toChangeSet(change: TextChange): ChangeSet {
  return ChangeSet.fromJSON(change);
}

// Text round-trips all line-separator exotica losslessly: only "\n" is treated as a line
// boundary, so "\r", "\r\n", "\u2028", "\u2029", and NUL stay inside their lines.
function applyTextChange(text: string, change: TextChange): string {
  return toChangeSet(change).apply(Text.of(text.split("\n"))).toString();
}

// Iterates a CodeChange's gadget entries as numeric ids. Assumes canonical keys
// (schema-validated or produced by this module).
function gadgetEntries(change: CodeChange): [number, [string, FileChange][]][] {
  return Object.entries(change).map(([key, value]) => [Number(key), value]);
}

// Builds a CodeChange with deterministic order (gadgets numeric ascending, entries by path),
// dropping empty gadget entries. Determinism matters because changes are stored and compared
// (e.g. the migration's conversion-determinism guarantee).
function makeCodeChange(gadgets: Map<number, Map<string, FileChange>>): CodeChange {
  let change: CodeChange = {};
  for (let gadgetId of [...gadgets.keys()].toSorted((x, y) => x - y)) {
    let files = gadgets.get(gadgetId)!;
    if (files.size === 0) continue;
    change[gadgetId] = [...files.keys()].toSorted().map(path => [path, files.get(path)!]);
  }
  return change;
}

// Pairs up two CodeChanges' file entries: yields (gadgetId, path, a's FileChange | undefined,
// b's FileChange | undefined) over the union of paths.
function* pairedFileChanges(a: CodeChange, b: CodeChange):
    Generator<[number, string, FileChange | undefined, FileChange | undefined]> {
  let toMaps = (change: CodeChange) => new Map(
      gadgetEntries(change).map(([id, entries]) => [id, new Map(entries)]));
  let aGadgets = toMaps(a);
  let bGadgets = toMaps(b);
  for (let gadgetId of new Set([...aGadgets.keys(), ...bGadgets.keys()])) {
    let aFiles = aGadgets.get(gadgetId) ?? new Map<string, FileChange>();
    let bFiles = bGadgets.get(gadgetId) ?? new Map<string, FileChange>();
    for (let path of new Set([...aFiles.keys(), ...bFiles.keys()])) {
      yield [gadgetId, path, aFiles.get(path), bFiles.get(path)];
    }
  }
}

// =======================================================================================
// Application

/**
 * Applies `change` to `content`, returning the resulting content. The input is not modified; the
 * result shares the file maps of untouched gadgets with it (treat both as immutable). A gadget
 * entry is created for any gadget the change touches. Throws if the change doesn't fit the
 * content (an `edit` of an absent file or of a file whose length doesn't match) -- ingestion
 * paths must have validated the change first, so a throw here indicates a bug.
 */
export function applyCodeChange(content: CodeContent, change: CodeChange): CodeContent {
  let result = new Map(content);
  for (let [gadgetId, fileChanges] of gadgetEntries(change)) {
    let files = new Map(result.get(gadgetId));
    result.set(gadgetId, files);
    for (let [path, fileChange] of fileChanges) {
      if ("set" in fileChange) {
        files.set(path, fileChange.set);
      } else if ("remove" in fileChange) {
        files.delete(path);
      } else {
        let existing = files.get(path);
        if (existing === undefined) {
          throw new Error(`edit of absent file: gadget ${gadgetId} ${path}`);
        }
        files.set(path, applyTextChange(existing, fileChange.edit));
      }
    }
  }
  return result;
}

// =======================================================================================
// Composition

/**
 * Composes two sequential changes into one with the same effect: `b` must apply to the content
 * produced by `a`, and `applyCodeChange(c, composeCodeChange(a, b))` equals
 * `applyCodeChange(applyCodeChange(c, a), b)`. Throws on changes that cannot be sequential (an
 * `edit` after a `remove`, or edits whose lengths don't chain) -- like `applyCodeChange`, a
 * throw indicates a bug in the caller, not bad client input.
 */
export function composeCodeChange(a: CodeChange, b: CodeChange): CodeChange {
  let gadgets = new Map<number, Map<string, FileChange>>();
  for (let [gadgetId, path, aChange, bChange] of pairedFileChanges(a, b)) {
    let files = gadgets.get(gadgetId) ?? new Map<string, FileChange>();
    gadgets.set(gadgetId, files);
    files.set(path, composeFileChange(gadgetId, path, aChange, bChange));
  }
  return makeCodeChange(gadgets);
}

function composeFileChange(
    gadgetId: number, path: string, a: FileChange | undefined, b: FileChange | undefined)
    : FileChange {
  if (a === undefined) return b!;
  if (b === undefined) return a;
  // b is later: its `set` or `remove` wholesale-supersedes whatever a did.
  if ("set" in b || "remove" in b) return b;
  // b is an edit of a's result.
  if ("set" in a) return { set: applyTextChange(a.set, b.edit) };
  if ("remove" in a) {
    throw new Error(`cannot compose edit after remove: gadget ${gadgetId} ${path}`);
  }
  return { edit: toChangeSet(a.edit).compose(toChangeSet(b.edit)).toJSON() };
}

// =======================================================================================
// Transformation

/**
 * The result of `transformCodeChange(a, b)`: each input change rebased to apply after the other,
 * under the fixed priority pairing. `a` is the original `a` transformed to apply after the
 * original `b`; `b` is the original `b` transformed to apply after the original `a`. Applying
 * either pairing to the same base -- original `a` then this `b`, or original `b` then this `a`
 * -- produces identical content.
 */
export interface TransformedCodeChanges {
  /** The earlier change, rebased to apply after the original `b`. Retains its priority. */
  a: CodeChange;

  /** The later change, rebased to apply after the original `a`. */
  b: CodeChange;
}

/**
 * Transforms two concurrent changes (both made against the same content) across each other. `a`
 * is the side the server ordered *earlier*, which fixes the priority convention: at equal
 * positions, `a`'s inserts precede `b`'s.
 *
 * Both sides of the wire use this one function. The server rebases an incoming change over the
 * changes already accepted since the change's claimed revision (each accepted change is `a`, the
 * incoming change is `b`); a client holding unacknowledged local edits rebases them over each
 * incoming broadcast change (the broadcast change is `a` -- the server accepted it first -- and
 * the client updates its display with the transformed `a` while keeping the transformed `b` as
 * its new pending change).
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
export function transformCodeChange(a: CodeChange, b: CodeChange): TransformedCodeChanges {
  let aGadgets = new Map<number, Map<string, FileChange>>();
  let bGadgets = new Map<number, Map<string, FileChange>>();
  for (let [gadgetId, path, aChange, bChange] of pairedFileChanges(a, b)) {
    let aFiles = aGadgets.get(gadgetId) ?? new Map<string, FileChange>();
    aGadgets.set(gadgetId, aFiles);
    let bFiles = bGadgets.get(gadgetId) ?? new Map<string, FileChange>();
    bGadgets.set(gadgetId, bFiles);

    if (aChange === undefined) {
      bFiles.set(path, bChange!);
    } else if (bChange === undefined) {
      aFiles.set(path, aChange);
    } else if ("edit" in aChange && "edit" in bChange) {
      let aSet = toChangeSet(aChange.edit);
      let bSet = toChangeSet(bChange.edit);
      aFiles.set(path, { edit: aSet.map(bSet, true).toJSON() });
      bFiles.set(path, { edit: bSet.map(aSet).toJSON() });
    } else if ("edit" in aChange) {
      // b's set/remove supersedes a's edit.
      bFiles.set(path, bChange);
    } else if ("edit" in bChange) {
      // a's set/remove wholesale-replaced b's base; b's edit is dropped.
      aFiles.set(path, aChange);
    } else {
      // Both set/remove: last-writer-wins by server order.
      bFiles.set(path, bChange);
    }
  }
  return { a: makeCodeChange(aGadgets), b: makeCodeChange(bGadgets) };
}

// =======================================================================================
// Diffing

/**
 * Computes the change that turns `before` into `after`:
 * `applyCodeChange(before, diffFiles(before, after))` equals `after`. Unchanged files contribute
 * nothing; added files become `set`, removed files `remove`, and changed files a minimal
 * character-level `edit` whose boundaries never split a UTF-16 surrogate pair. The result is
 * deterministic (same inputs, same change, same key and entry order), which the migration's
 * conversion messages rely on. Note a gadget with no files diffs identically to an absent
 * gadget: a code change carries only file changes, so gadget existence is not represented.
 */
export function diffFiles(before: CodeContent, after: CodeContent): CodeChange {
  let gadgets = new Map<number, Map<string, FileChange>>();
  for (let gadgetId of new Set([...before.keys(), ...after.keys()])) {
    let beforeFiles = before.get(gadgetId) ?? new Map<string, string>();
    let afterFiles = after.get(gadgetId) ?? new Map<string, string>();
    let files = new Map<string, FileChange>();
    for (let path of new Set([...beforeFiles.keys(), ...afterFiles.keys()])) {
      let beforeText = beforeFiles.get(path);
      let afterText = afterFiles.get(path);
      if (beforeText === afterText) continue;
      if (afterText === undefined) {
        files.set(path, { remove: true });
      } else if (beforeText === undefined) {
        files.set(path, { set: afterText });
      } else {
        files.set(path, { edit: diffTextChange(beforeText, afterText) });
      }
    }
    gadgets.set(gadgetId, files);
  }
  return makeCodeChange(gadgets);
}

// Folds fast-diff's edit script ([kind, text] runs over the whole strings) into ChangeSet
// change specs in original coordinates, merging each adjacent delete/insert run into a single
// replacement. fast-diff never splits surrogate pairs (verified by fuzz tests), so the
// resulting boundaries always pass validateCodeChangeContent.
function diffTextChange(before: string, after: string): TextChange {
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
 * Builds the TextChange that replaces `replaced` -- the document's exact text at
 * `[from, from + replaced.length)` -- with `insert`, in a document of length `docLength`. The
 * producer-side alternative to diffing when the replaced span is already known (editFile matched
 * it): no diff is run. A match is often padded with unchanged context to disambiguate it, so the
 * common prefix and suffix of `replaced` and `insert` are trimmed -- never splitting a UTF-16
 * surrogate pair -- and the change reports only the text that actually changed. Equal `replaced`
 * and `insert` yield the identity change; an out-of-range span throws (`ChangeSet.of` rejects it
 * at construction).
 */
export function replaceSpanChange(
    docLength: number, from: number, replaced: string, insert: string): TextChange {
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
  // The explicit "\n" line separator: see diffTextChange above.
  return ChangeSet.of(specs, docLength, "\n").toJSON();
}

// =======================================================================================
// Inspection

/** The gadget ids a change touches, ascending. Empty for the identity change. */
export function changedGadgets(change: CodeChange): number[] {
  return Object.keys(change).map(Number).toSorted((a, b) => a - b);
}

// =======================================================================================
// Validation (the trust boundary)

/**
 * Stage 1 of ingestion validation: the invariants a `CodeChange`'s type cannot express, checked
 * *before* any transform (transformation must only ever see schema-valid changes). The declared
 * shape is a precondition -- see the trust boundary note at the top of this module -- so this
 * verifies canonical decimal gadget keys; non-empty entry lists with non-empty, duplicate-free
 * paths; exactly one variant per `FileChange`; that every `edit` parses as a ChangeSet whose
 * sections are non-negative integers that each retain, delete, or insert something (do-nothing
 * padding is rejected) and whose inserted line strings contain no "\n"; and the size caps:
 * `MAX_FILE_TEXT_LENGTH` per produced file, `MAX_FILE_PATH_LENGTH` per path, and
 * `MAX_CODE_CHANGE_SIZE` for the change overall. Throws on the first violation.
 * Content-dependent checks (lengths, boundaries) are stage 2: `validateCodeChangeContent`.
 */
export function validateCodeChangeSchema(change: CodeChange): void {
  // The size cap is enforced as a running budget, not an after-the-fact sum: an edit's section
  // count is pre-checked in O(1) and the budget re-checked as each section's cost accrues, so a
  // hostile change is rejected before its sections are walked -- and in particular before
  // `ChangeSet.fromJSON` materializes a second copy of an oversized edit.
  let remaining = MAX_CODE_CHANGE_SIZE;
  for (let [gadgetKey, fileChanges] of Object.entries(change)) {
    let gadgetId = Number(gadgetKey);
    if (!Number.isSafeInteger(gadgetId) || gadgetId < 0 || String(gadgetId) !== gadgetKey) {
      throw new Error(`code change gadget key is not a canonical gadget id: ${gadgetKey}`);
    }
    if (fileChanges.length === 0) {
      throw new Error(`code change gadget entry is empty: gadget ${gadgetKey}`);
    }
    let seen = new Set<string>();
    for (let [path, fileChange] of fileChanges) {
      if (path === "") throw new Error(`code change file path is empty: gadget ${gadgetKey}`);
      if (path.length > MAX_FILE_PATH_LENGTH) {
        throw new Error(`code change file path is too long: gadget ${gadgetKey}`);
      }
      if (seen.has(path)) {
        throw new Error(`code change has a duplicate file entry: gadget ${gadgetKey} ${path}`);
      }
      seen.add(path);
      remaining -= FILE_ENTRY_SIZE_OVERHEAD + path.length;
      if (remaining < 0) throw new Error("code change is too large");
      remaining -= validateFileChangeSchema(`gadget ${gadgetKey} ${path}`, fileChange, remaining);
    }
  }
}

// Validates one FileChange's schema, returning its payload's share of the change size (see
// MAX_CODE_CHANGE_SIZE; always <= budget). Throws "code change is too large" as soon as the
// running cost exceeds `budget`, so an oversized payload is rejected without being fully walked.
function validateFileChangeSchema(where: string, fileChange: FileChange, budget: number): number {
  // Exactly one variant. This one is not the wire validator's to make: its union is first-match
  // and extra properties are allowed, so `{set, remove}` reaches us. It must not survive --
  // `applyCodeChange` tests `set` before `edit` while `transformCodeChange` tests `edit` first,
  // so a two-variant FileChange would be read differently by two replicas and diverge them.
  let keys = Object.keys(fileChange);
  if (keys.length !== 1 || !["edit", "set", "remove"].includes(keys[0])) {
    throw new Error(`file change must have exactly one of edit/set/remove: ${where}`);
  }
  if ("set" in fileChange) {
    if (fileChange.set.length > MAX_FILE_TEXT_LENGTH) {
      throw new Error(`file is too large: ${where}`);
    }
    if (fileChange.set.length > budget) throw new Error("code change is too large");
    return fileChange.set.length;
  }
  if ("remove" in fileChange) return 0;
  // ChangeSet.fromJSON is not strict enough on its own -- it accepts negative and non-integer
  // section lengths, sections that neither retain, delete, nor insert (free padding that would
  // evade the size caps), and inserted "line" strings containing "\n" (which desynchronize the
  // resulting document's line metadata from its text) -- so check sections ourselves first;
  // fromJSON then rejects the remaining malformed shapes, on input the budget has bounded.
  // O(1) budget pre-check on the section count alone, before any section is even looked at.
  let cost = fileChange.edit.length * EDIT_SECTION_SIZE_WEIGHT;
  if (cost > budget) throw new Error("code change is too large");
  for (let section of fileChange.edit) {
    if (Array.isArray(section)) {
      if (!Number.isSafeInteger(section[0]) || section[0] < 0) {
        throw new Error(`file change edit has an invalid section length: ${where}`);
      }
      // The inserted text's length: the lines' lengths plus the "\n" joining them. The
      // separator count is known before the lines are walked, so a section padded with empty
      // lines is rejected here in O(1) rather than after the walk.
      let insertedHere = section.length >= 2 ? section.length - 2 : 0;
      if (cost + insertedHere > budget) throw new Error("code change is too large");
      for (let i = 1; i < section.length; i++) {
        // A numeric index into `[number, ...string[]]` types as `string | number` because it
        // spans every element; every element past the first is a line.
        let line = section[i] as string;
        if (line.includes("\n")) {
          throw new Error(`file change edit inserted line contains a newline: ${where}`);
        }
        insertedHere += line.length;
      }
      if (section[0] === 0 && insertedHere === 0) {
        throw new Error(`file change edit has a do-nothing section: ${where}`);
      }
      cost += insertedHere;
      if (cost > budget) throw new Error("code change is too large");
    } else {
      if (!Number.isSafeInteger(section) || section < 0) {
        throw new Error(`file change edit has an invalid section length: ${where}`);
      }
      if (section === 0) throw new Error(`file change edit has a do-nothing section: ${where}`);
    }
  }
  let changes: ChangeSet;
  try {
    changes = toChangeSet(fileChange.edit);
  } catch (e) {
    throw new Error(`file change edit is malformed: ${where}: ${e}`, { cause: e });
  }
  if (changes.newLength > MAX_FILE_TEXT_LENGTH) throw new Error(`file is too large: ${where}`);
  return cost;
}

/**
 * Stage 2 of ingestion validation: the change against the content it will actually apply to,
 * checked *after* transforming it to the server's current revision (and only on schema-valid
 * changes -- run `validateCodeChangeSchema` first). Verifies each `edit` targets an existing file
 * of exactly the change's before-length, that every change boundary lands on a code-point
 * boundary of that file, and that no inserted or `set` text contains a lone UTF-16 surrogate.
 * The surrogate rules are what keep replicas byte-identical: changes travel as UTF-8 (where a
 * lone surrogate decodes as U+FFFD), so a mid-pair boundary or a lone surrogate would make remote
 * replicas disagree with the sender. Throws on the first violation.
 */
export function validateCodeChangeContent(change: CodeChange, content: CodeContent): void {
  for (let [gadgetId, fileChanges] of gadgetEntries(change)) {
    for (let [path, fileChange] of fileChanges) {
      let where = `gadget ${gadgetId} ${path}`;
      if ("set" in fileChange) {
        if (hasLoneSurrogate(fileChange.set)) {
          throw new Error(`file change set contains a lone surrogate: ${where}`);
        }
      } else if ("edit" in fileChange) {
        let text = content.get(gadgetId)?.get(path);
        if (text === undefined) throw new Error(`edit of absent file: ${where}`);
        let changes = toChangeSet(fileChange.edit);
        if (changes.length !== text.length) {
          throw new Error(`file change edit length mismatch: ${where}: ` +
              `change expects ${changes.length}, file has ${text.length}`);
        }
        changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          if (!isCodePointBoundary(text, fromA) || !isCodePointBoundary(text, toA)) {
            throw new Error(`file change edit splits a surrogate pair: ${where}`);
          }
          if (hasLoneSurrogate(inserted.toString())) {
            throw new Error(`file change edit inserts a lone surrogate: ${where}`);
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
