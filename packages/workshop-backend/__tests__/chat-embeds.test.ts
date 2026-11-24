import { describe, expect, it, vi } from "vitest";
import type { ChatEmbeds } from "@gadgets/workshop-shared/api";
import * as inlineBlocks from "@gadgets/workshop-shared/inline-html-blocks";
import { snapshotChatEmbeds } from "../src/chat-embeds";

const A = "a".repeat(40), B = "b".repeat(40);

describe("host-pinned answer files", () => {
  it("skips Markdown parsing for technical answers without a worktree reference", async () => {
    const parse = vi.spyOn(inlineBlocks, "parseInlineHtmlBlocks");
    try {
      await snapshotChatEmbeds('Use `a && b` and `C:\\temp`, then <p>a&amp;b</p>.', {},
          async () => undefined, true);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });

  it.each([
    '[Download](worktree&#58;//OUTPUTS/report.csv)',
    '<inline-html>\n<img src="worktree&#58;//OUTPUTS/report.csv">\n</inline-html>',
    '[Download](&#119;orktree://OUTPUTS/report.csv)',
    '[Download](worktree\\://OUTPUTS/report.csv)',
  ])("pins normalized schemes in %s", async text => {
    const snapshots: ChatEmbeds = {};
    const resolve = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    await snapshotChatEmbeds(text, snapshots, resolve);
    expect(snapshots).toEqual({"worktree://OUTPUTS/report.csv": A});
    expect(resolve).toHaveBeenCalledExactlyOnceWith("OUTPUTS", "report.csv");
  });

  it.each(["[Download]", "![Preview]"])("pins %s inside GFM footnotes", async label => {
    const snapshots: ChatEmbeds = {};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    await snapshotChatEmbeds("See the report.[^report]\n\n" +
        `[^report]: ${label}(worktree://OUTPUTS/report.csv)`,
        snapshots, read);
    expect(snapshots).toEqual({"worktree://OUTPUTS/report.csv": A});
    expect(read).toHaveBeenCalledExactlyOnceWith("OUTPUTS", "report.csv");
  });

  it.each([
    ["[^draft]: [Draft](worktree://OUTPUTS/draft.csv)", []],
    ["See[^live]\n\n[^live]: [Report](worktree://OUTPUTS/report.csv)\n" +
      "[^draft]: [Draft](worktree://OUTPUTS/draft.csv)", ["report.csv"]],
    ["See[^a]\n\n[^a]: ![A](worktree://OUTPUTS/a.png) [^b]\n" +
      "[^b]: ![B](worktree://OUTPUTS/b.png) [^a]\n" +
      "[^draft]: [Draft](worktree://OUTPUTS/draft.csv)", ["a.png", "b.png"]],
  ] as const)("pins only reachable footnote files: %s", async (text, paths) => {
    const snapshots: ChatEmbeds = {};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    await snapshotChatEmbeds(text + "\n", snapshots, read, true);
    await snapshotChatEmbeds(text, snapshots, read);
    expect(snapshots).toEqual(Object.fromEntries(paths.map(path => ["worktree://OUTPUTS/" + path, A])));
    expect(read.mock.calls.map(([, path]) => path)).toEqual(paths);
  });

  it("pins ordinary file links once, sharing an image's snapshot and preserving binary references", async () => {
    const snapshots: ChatEmbeds = {};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    const source = "worktree://OUTPUTS/mandelbrot.png";
    await snapshotChatEmbeds(`[Download PNG](${source}) ![Preview](${source})`, snapshots, read, true);
    expect(snapshots).toEqual({[source]: A});
    expect(read).toHaveBeenCalledExactlyOnceWith("OUTPUTS", "mandelbrot.png");
    read.mockResolvedValue(B);
    await snapshotChatEmbeds(`[Download PNG](${source}) [Download archive](worktree://OUTPUTS/build.zip)`, snapshots, read);
    expect(snapshots).toEqual({[source]: A, "worktree://OUTPUTS/build.zip": B});
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("waits for complete file links and their reference definitions", async () => {
    const snapshots: ChatEmbeds = {};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    await snapshotChatEmbeds('[Download](<worktree://OUTPUTS/ü report.csv>', snapshots, read, true);
    expect(read).not.toHaveBeenCalled();
    await snapshotChatEmbeds('[Download](<worktree://OUTPUTS/ü report.csv>)', snapshots, read, true);
    expect(snapshots).toEqual({"worktree://OUTPUTS/%C3%BC%20report.csv": A});
    expect(read).toHaveBeenCalledExactlyOnceWith("OUTPUTS", "ü report.csv");
    await snapshotChatEmbeds('[Source][code]\n\n[code]: worktree://OUTPUTS/main', snapshots, read, true);
    expect(read).toHaveBeenCalledTimes(1);
    await snapshotChatEmbeds('[Source][code]\n\n[code]: worktree://OUTPUTS/main.cpp\n', snapshots, read, true);
    expect(snapshots["worktree://OUTPUTS/main.cpp"]).toBe(A);
  });

  it("pins an image when its Markdown completes and never resolves that path again in this message", async () => {
    const images: ChatEmbeds = {};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    const text = "![Result](worktree://REPO/my%20image.png)";
    expect(await snapshotChatEmbeds(text.slice(0, -1), images, read, true)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(await snapshotChatEmbeds(text, images, read, true)).toEqual({"worktree://REPO/my%20image.png": A});
    expect(read).toHaveBeenCalledWith("REPO", "my image.png");
    read.mockResolvedValue(B);
    expect(await snapshotChatEmbeds(text + "\n" + text, images, read)).toBeUndefined();
    expect(images).toEqual({"worktree://REPO/my%20image.png": A});
    expect(read).toHaveBeenCalledTimes(1);
    const next: ChatEmbeds = {};
    await snapshotChatEmbeds(text, next, read);
    expect(next).toEqual({"worktree://REPO/my%20image.png": B});
  });

  it("records a missing or failed lookup once, instead of filling old replies with a later file", async () => {
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>()
        .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Unavailable"));
    const images: ChatEmbeds = {};
    const text = "![Missing](worktree://SCRATCH/missing.png) ![Failed](worktree://SCRATCH/failed.png)";
    await snapshotChatEmbeds(text, images, read);
    expect(images).toEqual({"worktree://SCRATCH/missing.png": null, "worktree://SCRATCH/failed.png": null});
    read.mockResolvedValue(A);
    await snapshotChatEmbeds(text, images, read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["![Image](worktree://REPO/ü.png)", "worktree://REPO/%C3%BC.png", "ü.png"],
    ["![Image](<worktree://REPO/my image.png>)", "worktree://REPO/my%20image.png", "my image.png"],
    ["![Image][picture]\n\n[picture]: <worktree://REPO/ü image.png>\n", "worktree://REPO/%C3%BC%20image.png", "ü image.png"],
  ])("uses the renderer's normalized image key for %s", async (text, source, path) => {
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    const images: ChatEmbeds = {};
    await snapshotChatEmbeds(text, images, read);
    expect(images).toEqual({[source]: A});
    expect(read).toHaveBeenCalledExactlyOnceWith("REPO", path);
  });

  it("uses real HTML attribute parsing and waits for partial image tags", async () => {
    const images: ChatEmbeds = {};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    const prefix = '<inline-html>\n<img alt="x > y" src="worktree://SCRATCH/a';
    await snapshotChatEmbeds(prefix, images, read, true);
    expect(read).not.toHaveBeenCalled();
    await snapshotChatEmbeds(prefix + '.png">\n', images, read, true);
    expect(read).toHaveBeenCalledWith("SCRATCH", "a.png");
    // A view reads every URL its text quotes, so quoted URLs in a comment or a script pin too.
    await snapshotChatEmbeds(prefix + '.png">\n<!-- <img src="worktree://SCRATCH/comment.png"> -->\n' +
        '<script>const example = \'<img src="worktree://SCRATCH/script.png">\';</script>\n</inline-html>', images, read);
    expect(read.mock.calls.map(([, path]) => path)).toEqual(["a.png", "comment.png", "script.png"]);
  });

  it("pins every URL a view's raw text quotes, in scripts, SVG, templates and attributes alike", async () => {
    const snapshots: ChatEmbeds = {};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    await snapshotChatEmbeds('<inline-html>\n<script type="module">await embeds.json("worktree://OUTPUTS/a.json");</script>\n' +
        "<svg><script>embeds.text('worktree://OUTPUTS/b.csv')</script></svg>\n" +
        "<template><script>embeds.text(`worktree://OUTPUTS/c.txt`)</script></template>\n" +
        '<p data-file="worktree://OUTPUTS/d.json"></p>\n</inline-html>\n\n' +
        'Prose that quotes "worktree://OUTPUTS/prose.json" pins nothing.', snapshots, read);
    expect(Object.keys(snapshots).toSorted()).toEqual(
        ["a.json", "b.csv", "c.txt", "d.json"].map(path => "worktree://OUTPUTS/" + path));
  });

  it("pins a quoted URL only once its quote closes, and on a last line with no newline", async () => {
    const snapshots: ChatEmbeds = {};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    const open = '<inline-html>\n<script type="module">\nawait embeds.json("worktree://OUTPUTS/sales';
    await snapshotChatEmbeds(open + "\n", snapshots, read, true);
    expect(read).not.toHaveBeenCalled();
    await snapshotChatEmbeds(open + '.json");\n</script>\n</inline-html>', snapshots, read);
    expect(snapshots).toEqual({"worktree://OUTPUTS/sales.json": A});
  });

  it.each([false, true])("keeps pinning other references after an invalid inline view (streaming: %s)", async streaming => {
    const snapshots: ChatEmbeds = {};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    await snapshotChatEmbeds('<inline-html>\n<select><title>Display mode</title><option>Table</option></select>\n</inline-html>\n\n' +
        '[CSV](worktree://OUTPUTS/report.csv)\n\n' +
        '<inline-html>\n<img src="worktree://OUTPUTS/image.png">\n</inline-html>', snapshots, read, streaming);
    expect(snapshots).toEqual({"worktree://OUTPUTS/report.csv": A, "worktree://OUTPUTS/image.png": A});
  });

  it("drops a streamed view's pins if its saved block never closes", async () => {
    const source = "worktree://OUTPUTS/image.png", snapshots: ChatEmbeds = {};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    const text = '<inline-html>\n<img src="' + source + '">\n';
    await snapshotChatEmbeds(text, snapshots, read, true);
    expect(snapshots).toEqual({[source]: A});
    expect(await snapshotChatEmbeds(text, snapshots, read)).toEqual({[source]: null});
    expect(snapshots).toEqual({});
    expect(read).toHaveBeenCalledTimes(1);
    await snapshotChatEmbeds(text + '</inline-html>', snapshots, read);
    expect(snapshots).toEqual({[source]: A});
  });

  it.each([
    ["a&amp;b.png", "a&b.png"],
    ["a&#38;b.png", "a&b.png"],
    ["a&#x26;b.png", "a&b.png"],
    ["a&amp;amp;b.png", "a&amp;b.png"],
    ["a&notit;.png", "a&notit;.png"],
    ["a&quot;b.png", 'a"b.png'],
    ["a&#x1f600;.png", "a😀.png"],
  ])("pins the DOM-decoded HTML attribute exactly once: %s", async (attribute, path) => {
    const images: ChatEmbeds = {};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    const text = `<inline-html>\n<img src="worktree://REPO/${attribute}">\n</inline-html>`;
    expect(await snapshotChatEmbeds(text, images, read)).toEqual({[`worktree://REPO/${path}`]: A});
    expect(images).toEqual({[`worktree://REPO/${path}`]: A});
    await snapshotChatEmbeds(text, images, read);
    expect(read).toHaveBeenCalledExactlyOnceWith("REPO", path);
  });

  it.each([
    ["&#46;&#46;/secret", "../secret"],
    ["a&#92;b.png", "a\\b.png"],
    ["&#37;00", "%00"],
  ])("validates HTML paths after entity decoding: %s", async (attribute, path) => {
    const images: ChatEmbeds = {};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>();
    await snapshotChatEmbeds(`<inline-html>\n<img src="worktree://REPO/${attribute}">\n</inline-html>`, images, read);
    expect(images).toEqual({[`worktree://REPO/${path}`]: null});
    expect(read).not.toHaveBeenCalled();
  });

  it("waits for complete reference definitions and ignores examples and other schemes", async () => {
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    const images: ChatEmbeds = {};
    const text = "![Image][picture]\n\n[picture]: worktree://REPO/result";
    await snapshotChatEmbeds(text, images, read, true);
    expect(read).not.toHaveBeenCalled();
    await snapshotChatEmbeds(text + ".png\n", images, read, true);
    expect(read).toHaveBeenCalledWith("REPO", "result.png");
    await snapshotChatEmbeds('`![Example](worktree://REPO/code.png)`\n\n' +
        '```html\n<inline-html>\n<img src="worktree://REPO/example.png">\n</inline-html>\n```\n\n' +
        '`[Example](worktree://REPO/link.png)` ![Old](worktree:REPO/old.png) ![Oid](git-blob:' + A + ')', images, read);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["paragraph", "", "`"],
    ["double-backtick paragraph", "", "``"],
    ["heading", "# ", "`"],
    ["table cell", "| Example |\n| --- |\n| ", "`"],
  ])("does not pin an unfinished code example in a %s while streaming", async (_kind, prefix, marker) => {
    const snapshots: ChatEmbeds = {};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    const example = prefix + marker + "![Example](worktree://OUTPUTS/image.png)";
    await snapshotChatEmbeds(example, snapshots, read, true);
    expect(snapshots).toEqual({});
    expect(read).not.toHaveBeenCalled();
    await snapshotChatEmbeds(example + marker, snapshots, read);
    expect(snapshots).toEqual({});
    expect(read).not.toHaveBeenCalled();
    // A literal, unclosed backtick is prose at EOF, so its real image still works.
    await snapshotChatEmbeds(example, snapshots, read);
    expect(snapshots).toEqual({"worktree://OUTPUTS/image.png": A});
  });

  it.each(["`![Example](worktree://OUTPUTS/example.png)`", "Example removed"])(
      "drops provisional pins absent from the final rendered message: %s", async example => {
    const source = "worktree://OUTPUTS/example.png", real = "worktree://OUTPUTS/real.png";
    const snapshots: ChatEmbeds = {[source]: A, [real]: B};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>();
    expect(await snapshotChatEmbeds(example + ' ![Real](' + real + ')', snapshots, read))
        .toEqual({[source]: null});
    expect(snapshots).toEqual({[real]: B});
    expect(read).not.toHaveBeenCalled();
  });

  it("pins the first reference definition, matching the Markdown renderer", async () => {
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>().mockResolvedValue(A);
    const images: ChatEmbeds = {};
    await snapshotChatEmbeds("![Image][picture]\n\n[picture]: worktree://REPO/first.png\n" +
        "[picture]: worktree://REPO/second.png\n", images, read);
    expect(read).toHaveBeenCalledExactlyOnceWith("REPO", "first.png");
    expect(images).toEqual({"worktree://REPO/first.png": A});
  });

  it.each(["worktree://REPO/../secret", "worktree://REPO/%2e%2e/secret", "worktree://REPO/%00", "worktree://REPO/a%5cb.png"])(
      "does not resolve invalid paths: %s", async source => {
    const images: ChatEmbeds = {};
    const read = vi.fn<(binding: string, path: string) => Promise<string | undefined>>();
    await snapshotChatEmbeds(`![Invalid](${source})`, images, read);
    expect(images).toEqual({[source]: null});
    expect(read).not.toHaveBeenCalled();
  });
});
