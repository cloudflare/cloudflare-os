// This file declares the type of the `env.EXPORTS` binding (see exports-session.ts), present in
// the agent's executeCode env: programmatic access to Gadgets' file exports -- the same formats,
// and the same files, as the Workshop's Export menu.
//
// The agent's `describeBinding` tool serves the agent-facing section of this file as text
// (exports-binding.txt is a symlink to this file, shipped as a Text module -- the
// worktree-binding.txt pattern), so everything below the marker is written for the agent as its
// audience.

// Everything below the following line is returned to agents via `describeBinding`.
// ---- BEGIN AGENT API ----

/**
 * The `env.EXPORTS` binding, available in your `executeCode` env. Exports a Gadget's content as a
 * file, in any format the Gadget offers: the same files a user downloads from the Workshop's Export
 * menu. Name the Gadget by its binding name in your env, e.g. `"MY_GADGET"` for `env.MY_GADGET`.
 * A Gadget is exported as this conversation sees it, including the changes proposed here.
 */
export interface Exports {
  /** List the formats the Gadget can be exported in. An empty list means it offers none. */
  getFormats(gadget: string): Promise<ExportFormat[]>;

  /**
   * Export the Gadget in the format whose `id` is given (one listed by `getFormats()`), returning
   * the file's content. Read it with e.g. `await new Response(stream).text()`, or pass the stream
   * on to something that accepts a file.
   */
  export(gadget: string, formatId: string): Promise<ReadableStream<Uint8Array>>;
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
};
