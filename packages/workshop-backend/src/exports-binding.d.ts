// This file declares the type of a gadget binding's `exports` property (see exports-session.ts)
// in the agent's executeCode env: programmatic access to the Gadget's file exports -- the same
// formats, and the same files, as the Workshop's Export menu.
//
// The agent's `describeBinding` tool serves the agent-facing section of this file as text
// (exports-binding.txt is a symlink to this file, shipped as a Text module -- the
// worktree-binding.txt pattern), so everything below the marker is written for the agent as its
// audience.

// Everything below the following line is returned to agents via `describeBinding`.
// ---- BEGIN AGENT API ----

/**
 * Exports a Gadget's content as a file, in any format the Gadget offers: the same files a user
 * downloads from the Workshop's Export menu. Available in your `executeCode` env as the `exports`
 * property of each Gadget binding, e.g. `env.MY_GADGET.exports`. A Gadget is exported as this
 * conversation sees it, including the changes proposed here.
 */
export interface GadgetExports {
  /** List the formats the Gadget can be exported in. An empty list means it offers none. */
  getFormats(): Promise<ExportFormat[]>;

  /**
   * Export the Gadget in the format whose `id` is given (one listed by `getFormats()`), returning
   * the file's content. Read it with e.g. `await new Response(stream).text()`, or pass the stream
   * on to something that accepts a file.
   */
  export(formatId: string): Promise<ReadableStream<Uint8Array>>;
}

/** One format a Gadget can be exported in. */
export type ExportFormat = {
  /** Identifies the format; pass it to `export()`. */
  id: string;

  /** The format's name as users see it. */
  label: string;

  /** Whether the file is a capture of the Gadget's UI ("browser") or made by its server code. */
  mode: "browser" | "server";

  /** Media type of the exported file. */
  contentType: string;

  /** File extension, including the leading dot. */
  fileExtension: string;

  /** Suggested download filename, including its extension. Defaults to the Gadget title plus fileExtension when unset. */
  fileName?: string;
};
