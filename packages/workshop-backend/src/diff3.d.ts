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
