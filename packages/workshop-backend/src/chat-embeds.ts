import { validateBindingName, type ChatEmbeds } from "@gadgets/workshop-shared/api";
import { markdownFileUrls, parseInlineHtmlBlocks, quotedFileUrls } from "@gadgets/workshop-shared/inline-html-blocks";
import { decodeHTML, decodeHTMLAttribute } from "entities/decode";

/** Pin emitted file references once, removing provisional pins absent from the final message. */
export async function snapshotChatEmbeds(
    text: string, snapshots: ChatEmbeds,
    resolve: (binding: string, path: string) => Promise<string | undefined>,
    streaming = false): Promise<ChatEmbeds | undefined> {
  // Character references and Markdown escapes can encode parts of the scheme.
  if ((streaming || Object.keys(snapshots).length === 0) && !text.includes("worktree://") &&
      !decodeHTML(text).replace(/\\([:/])/g, "$1").includes("worktree://")) return;
  const sources = new Set<string>();
  for (const part of parseInlineHtmlBlocks(text, {streaming})) {
    if (part.kind === "text") {
      for (const url of markdownFileUrls(part.text, streaming)) sources.add(url);
    } else if (streaming || part.kind === "block") {
      // The view's data files: the URLs its raw text quotes (any view reads any file this pins).
      for (const url of quotedFileUrls(part.html)) sources.add(url);
      // HTMLRewriter preserves character references in attributes; decode once to match the
      // browser's getAttribute() before pinning the URL or resolving its path.
      try {
        await new HTMLRewriter().on("img", {element(element) {
          const src = element.getAttribute("src");
          if (src !== null) sources.add(decodeHTMLAttribute(src));
        }}).transform(new Response(part.html)).text();
      } catch {
        // HTMLRewriter rejects some malformed markup browsers tolerate. One bad view must
        // not discard the answer or prevent pinning references in the other blocks.
      }
    }
  }
  let updates: ChatEmbeds | undefined;
  if (!streaming) {
    for (const source of Object.keys(snapshots)) {
      if (sources.has(source)) continue;
      delete snapshots[source];
      (updates ??= {})[source] = null;
    }
  }
  for (const source of sources) {
    if (!source.startsWith("worktree://") || Object.hasOwn(snapshots, source)) continue;
    let oid: string | null = null;
    try {
      const match = /^worktree:\/\/([^/]+)\/(.+)$/.exec(source);
      if (!match) throw new Error("Invalid worktree file URL.");
      const binding = decodeURIComponent(match[1]), path = decodeURIComponent(match[2]);
      validateBindingName(binding);
      if (path.includes("\0") || path.includes("\\") ||
          path.split("/").some(part => part === "" || part === "." || part === "..")) {
        throw new Error("Invalid worktree file path.");
      }
      oid = await resolve(binding, path) ?? null;
    } catch {
      // A bad file reference must not fail the answer, nor silently resolve against a later file version.
    }
    snapshots[source] = oid;
    (updates ??= {})[source] = oid;
  }
  return updates;
}
