// Minimal typings for the `diff3` package (CJS, untyped): the same tiny diff3 engine
// isomorphic-git uses internally, consumed directly by git-store.ts's threeWayMerge. Shapes match
// diff3@0.0.3's diff3Merge() return value.

declare module "diff3" {
  /** A run of lines that merged cleanly. */
  export interface Diff3OkRegion<T> {
    ok: T[];
  }

  /** A conflicting run: `a` is the first input (ours), `o` the base, `b` the third (theirs). */
  export interface Diff3ConflictRegion<T> {
    conflict: {
      a: T[];
      aIndex: number;
      o: T[];
      oIndex: number;
      b: T[];
      bIndex: number;
    };
  }

  export type Diff3Region<T> = Diff3OkRegion<T> | Diff3ConflictRegion<T>;

  /**
   * Three-way merge of line arrays: `a` and `b` are the two sides, `o` the common ancestor.
   * Returns alternating clean and conflicting regions.
   */
  export default function diff3Merge<T>(a: T[], o: T[], b: T[]): Diff3Region<T>[];
}

// The two-way diff engine behind diff3Merge (Wu-Manber-Myers O(NP)), used directly by
// yjs-files.ts's applyTextEdit. The package doesn't re-export it, but it also declares no
// `exports` map to forbid the subpath, and it has been frozen at 0.0.3 since 2015 -- treat any
// upgrade as a breaking change to these typings.
declare module "diff3/onp.js" {
  /** One edit-script entry: the line and what happened to it. */
  export interface SesElem<T> {
    elem: T;
    /** SES_DELETE (-1): only in `a`. SES_COMMON (0): in both. SES_ADD (1): only in `b`. */
    t: -1 | 0 | 1;
  }

  export interface Onp<T> {
    SES_DELETE: -1;
    SES_COMMON: 0;
    SES_ADD: 1;
    /** Runs the diff; must be called before the getters below. */
    compose(): void;
    /**
     * The shortest edit script from `a` to `b`, in order: deletions consume consecutive lines
     * of `a`, additions consecutive lines of `b`, common entries one of each.
     */
    getses(): SesElem<T>[];
    editdistance(): number;
  }

  /** Factory (usable with or without `new`): diff line arrays `a` against `b`. */
  export default function onp<T>(a: T[], b: T[]): Onp<T>;
}
