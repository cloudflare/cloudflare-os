import { useRef, useState, type DragEvent } from "react";

type UseComposerAttachmentDropOptions = {
  attachmentCount: number;
  maxAttachments: number;
  onFilesDropped: (files: FileList) => void;
};

const hasDraggedFiles = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer.types).includes("Files");

export const useComposerAttachmentDrop = ({
  attachmentCount,
  maxAttachments,
  onFilesDropped,
}: UseComposerAttachmentDropOptions) => {
  const [isActive, setIsActive] = useState(false);
  const dragDepthRef = useRef(0);
  const canAttachMore = attachmentCount < maxAttachments;

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current++;
    setIsActive(true);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canAttachMore ? "copy" : "none";
    setIsActive(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsActive(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsActive(false);
    onFilesDropped(event.dataTransfer.files);
  };

  return { canAttachMore, isActive, onDragEnter, onDragLeave, onDragOver, onDrop };
};
