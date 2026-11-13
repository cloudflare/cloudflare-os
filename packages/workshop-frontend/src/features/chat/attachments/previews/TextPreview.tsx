import { useMemo } from "react";
import CodeEditor from "../../../code/CodeEditor";
import type { AttachmentPreviewProps } from "../attachmentPreviewers";
import { decodeText } from "./decodeText";

/** Text and source code, read-only, highlighted by the file's extension. */
export const TextPreview = ({ bytes, name }: AttachmentPreviewProps) => {
  // The chat re-renders on every streamed token; a large file is decoded once, not each time.
  const text = useMemo(() => decodeText(bytes), [bytes]);
  if (text === "") {
    return <div className="grid h-full place-items-center text-[13px] text-kumo-subtle">This file is empty.</div>;
  }
  return <CodeEditor filename={name} text={text} />;
};
