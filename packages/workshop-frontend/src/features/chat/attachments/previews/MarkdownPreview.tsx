import { useMemo } from "react";
import type { AttachmentPreviewProps } from "../attachmentPreviewers";
import { decodeText } from "./decodeText";
import { MarkdownDocument } from "./MarkdownDocument";

/** A Markdown file, rendered. */
export const MarkdownPreview = ({ bytes }: AttachmentPreviewProps) => {
  // The chat re-renders on every streamed token; a large file is decoded once, not each time.
  const markdown = useMemo(() => decodeText(bytes), [bytes]);
  if (markdown.trim() === "") {
    return <div className="grid h-full place-items-center text-[13px] text-kumo-subtle">This file is empty.</div>;
  }
  return (
    <div className="min-h-full bg-kumo-base">
      <MarkdownDocument markdown={markdown} />
    </div>
  );
};
