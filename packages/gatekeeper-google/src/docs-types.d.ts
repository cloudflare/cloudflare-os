import type { DocSuggestion, DriveComment, DriveCommentReply } from "./comment-types";
import type { GoogleDocReadSession } from "./docs-read-types";
export type { DocMetadata, GoogleDocReadSession, GoogleDocTab } from "./docs-read-types";

/** Options for {@link GoogleDocSession.comment}. */
export type DocCommentOptions = {
  /**
   * Text of the Doc this comment is about, within one paragraph and at most 500 characters, which
   * must occur exactly once in the tab as Google has it saved, not counting edits still waiting for
   * approval: the tab's text as `getContent()` shows it, without Markdown formatting (no `**`, list
   * markers or escapes) and, in a table, without HTML (`&` rather than `&amp;`, no tags). The
   * comment is attached to it, as one made in the Docs editor is, and it must still occur exactly
   * once in the tab when the comment is approved.
   */
  quote: string;
  /** The tab `quote` is in: an ID returned by `listTabs()`, omitted only when there is one tab. */
  tabId?: string;
};

/** Options for {@link GoogleDocSession.suggestEdit}. */
export type DocSuggestEditOptions = {
  /** Why, posted as a reply on the suggestion; at most 2048 bytes of UTF-8. */
  note?: string;
  /** The tab `oldText` is in: an ID returned by `listTabs()`, omitted only when there is one tab. */
  tabId?: string;
};

/**
 * Read/write access to one directly bound native Google Doc, and to its comments.
 *
 * Metadata covers the whole document; reads and edits each target exactly one tab, so call
 * `listTabs()` first and pass the ID of the tab to act on.
 *
 * When to use which:
 * - `replaceText()` and `appendText()` change the Doc's text once the user approves them.
 * - `addTab()` adds a new, empty tab, which the edits above can fill at once.
 * - `suggestEdit()` leaves a suggestion in the Doc, as one made in Suggesting mode, which someone
 *   who can edit the Doc accepts or rejects there; the text does not change until then.
 * - `comment()` is a remark on a passage of the Doc, attached to the text it quotes.
 * - `reply()` and `resolve()` answer the comments `listComments()` returns.
 * - A comment attached to no text, or an answer to one, takes a Google Drive connection to the
 *   file with read and write access: request the resource URL
 *   `https://drive.google.com/file/d/<id>/view?access=write`, where `<id>` is `getMetadata().id`.
 *
 * Every comment write is queued for the user's approval. A comment, reply or resolve returns the
 * pending item, which `listComments()` shows until it is decided; `suggestEdit()` returns a
 * `DocSuggestion`, which no listing shows, queued or made. A write needs the connected account to
 * be able to comment on the Doc, and a new comment makes Google email the Doc's owner. An email
 * address written after `@` or `+` in the text mentions that person: Google emails them the text,
 * whether or not they can open the Doc. A comment, reply or note holds at most 2048 bytes of UTF-8.
 * A Doc not created yet has no comments, and takes no comment writes until it is.
 */
export interface GoogleDocSession extends GoogleDocReadSession {

  /**
   * Find `oldMarkdown` in tab `tabId` and replace it with `newMarkdown`.
   * Both parameters are Markdown text.
   *
   * Matching and editing are local to that one tab: pass an ID returned by `listTabs()`, and omit
   * `tabId` only when `listTabs()` returns exactly one tab.
   *
   * The match must be unique -- if `oldMarkdown` appears zero times or more than once in the
   * selected tab, an error is thrown. If the match is ambiguous, include more surrounding context
   * in `oldMarkdown` to disambiguate.
   *
   * The gatekeeper automatically trims unchanged leading and trailing text before sending the
   * edit to Google Docs, so it's fine (and encouraged) to include extra context in `oldMarkdown`
   * and `newMarkdown` for matching purposes.
   *
   * The Markdown is mapped back to Google Docs operations using the tab's source map. The
   * following Markdown features are supported in `newMarkdown`:
   * - Headings (`# ` through `###### `)
   * - Bold (`**text**`)
   * - Italic (`*text*`)
   * - Bold+italic (`***text***`)
   * - Links (`[text](url)`)
   * - Strikethrough (`~~text~~`)
   * - Bullet lists (`- item`)
   * - Numbered lists (`1. item`)
   * - Plain paragraphs (separated by blank lines)
   * - Line breaks within a paragraph (`\u000b`, as `getContent()` returns them)
   *
   * Unsupported Markdown features (tables, images, code blocks, etc.) are inserted as plain text.
   * Existing structural content and paragraphs containing elements such as smart chips are
   * read-only. Narrow the match to plain text in another paragraph.
   *
   * A subsequent `getContent(tabId)` call reflects this replacement.
   */
  replaceText(oldMarkdown: string, newMarkdown: string, tabId?: string): Promise<void>;

  /**
   * Append Markdown content to the end of tab `tabId`. The same Markdown features and tab
   * selection rules as `replaceText()` apply. The tab must end in a paragraph; add one after a
   * final table or other structural element before appending.
   */
  appendText(markdown: string, tabId?: string): Promise<void>;

  /**
   * Add a new, empty tab titled `title` (one line, at most 50 characters): nested under the tab
   * `parentTabId` names, or top-level without one, and placed at `index` among the tabs beside it,
   * counting from 0, or last without one. Google nests tabs at most three levels deep. Resolves to
   * the new tab's ID: `listTabs()` lists the tab at once, and `getContent()`, `replaceText()`,
   * `appendText()` and `addTab()` take its ID at once.
   */
  addTab(title: string, options?: { parentTabId?: string; index?: number }): Promise<string>;

  /**
   * Every comment on the Doc, attached to text or not, with its replies, and this binding's
   * comments, replies and resolves still waiting for approval (`pending`). A suggestion is not a
   * comment, and is not listed. Fails for an account that can only view the Doc: Google shows a
   * Doc's comments only to accounts that can comment on it.
   */
  listComments(): Promise<DriveComment[]>;

  /** Queue a plain-text comment attached to the text `options.quote`. */
  comment(text: string, options: DocCommentOptions): Promise<DriveComment>;

  /**
   * Queue a suggestion that `oldText`, which must occur exactly once in the tab (matched and
   * limited as `quote` is), be replaced with `newText`: empty to delete it, otherwise at most 1000
   * characters without line breaks. At approval `oldText` must still occur exactly once in the tab.
   */
  suggestEdit(
    oldText: string, newText: string, options?: DocSuggestEditOptions,
  ): Promise<DocSuggestion>;

  /**
   * Queue a reply to comment `commentId`, an ID `listComments()` returned. Replying to a resolved
   * comment reopens it. Fails for a comment attached to no text, saying which Drive connection can
   * answer it; for one that is itself still `pending`, which takes replies once it is posted; and
   * for one with a resolve awaiting approval, which the reply would reopen (to close a comment with
   * words, resolve it with them). At approval the reply fails if the comment was edited after the
   * reply was queued.
   */
  reply(commentId: string, text: string): Promise<DriveCommentReply>;

  /**
   * Queue resolving comment `commentId`, with an optional closing reply. Fails for a comment that
   * is already resolved, that already has a resolve awaiting approval, that is itself still
   * `pending`, or that is attached to no text. At approval the resolve fails if the comment was
   * edited after the resolve was queued.
   */
  resolve(commentId: string, text?: string): Promise<DriveCommentReply>;
}
