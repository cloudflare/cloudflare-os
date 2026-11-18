import { validateBindingName, type ChatEmbeds } from "@gadgets/workshop-shared/api";
import { markdownFileUrls, parseInlineHtmlBlocks } from "@gadgets/workshop-shared/inline-html-blocks";
import { decodeHTMLAttribute } from "entities/decode";

/** Pin newly emitted file references once; a failed lookup stays unavailable in this message. */
export async function snapshotChatEmbeds(
    text: string, snapshots: ChatEmbeds,
    resolve: (binding: string, path: string) => Promise<string | undefined>,
    streaming = false): Promise<ChatEmbeds | undefined> {
  // Character references and Markdown escapes can encode parts of the scheme.
  if (!text.includes("worktree://") && !text.includes("&") && !text.includes("\\")) return;
  const sources = new Set<string>();
  for (const part of parseInlineHtmlBlocks(text, {streaming})) {
    if (part.kind === "text") {
      for (const url of markdownFileUrls(part.text, streaming)) sources.add(url);
    } else {
      // HTMLRewriter preserves character references in attributes; decode once to match the
      // browser's getAttribute() before pinning the URL or resolving its path.
      await new HTMLRewriter().on("img", {element(element) {
        const src = element.getAttribute("src");
        if (src !== null) sources.add(decodeHTMLAttribute(src));
      }}).transform(new Response(part.html)).text();
    }
  }
  let added: ChatEmbeds | undefined;
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
    (added ??= {})[source] = oid;
  }
  return added;
}
