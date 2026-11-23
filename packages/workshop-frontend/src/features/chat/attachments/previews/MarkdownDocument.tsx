import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "../../../../ChatInterface.module.css";
import { safeExternalUrl } from "../../../../utils/safeExternalUrl";

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const safeHref = safeExternalUrl(href);
    return safeHref
      ? <a href={safeHref} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>;
  },
};

// A file is untrusted: its raw HTML is dropped, and so are its images, which would otherwise make
// the reader's browser fetch whatever address the file's author chose.
const DISALLOWED = ["img"];

// The chat's Markdown keeps headings at the size of a message's text; a document's stand out.
const HEADING_SIZES = "[&_h1]:text-[22px] [&_h2]:text-[18px] [&_h3]:text-[16px] [&_h4]:text-[14px]";

/** Markdown from a file, laid out as a page and styled like the chat's own Markdown. */
export const MarkdownDocument = memo(({ markdown }: { markdown: string }) => (
  <div className={`mx-auto max-w-[760px] px-6 py-6 text-[14px] text-kumo-default ${HEADING_SIZES} ${styles.markdownContent}`}>
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      disallowedElements={DISALLOWED}
      components={COMPONENTS}
    >
      {markdown}
    </ReactMarkdown>
  </div>
));
MarkdownDocument.displayName = "MarkdownDocument";
