import { useEffect, useRef, useState, type DragEvent } from "react";

type UseComposerAttachmentDropOptions = {
  attachmentCount: number;
  maxAttachments: number;
  onFilesDropped: (files: FileList) => void;
};

const hasDraggedFiles = (event: DragEvent | globalThis.DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");

/**
 * Takes files dropped on the composer, or anywhere else in the window while it is on screen, so
 * a file let go of a little off target attaches instead of the browser opening it in place of
 * the app. `isDragging` is true while files are over the window, `isActive` while they are over
 * the composer itself, so the composer can say where to drop, then that it will take them. A drop
 * some other target claims (by preventing its default) is left to it.
 */
export const useComposerAttachmentDrop = ({
  attachmentCount,
  maxAttachments,
  onFilesDropped,
}: UseComposerAttachmentDropOptions) => {
  const [isActive, setIsActive] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const canAttachMore = attachmentCount < maxAttachments;
  const latest = useRef({ canAttachMore, onFilesDropped });
  latest.current = { canAttachMore, onFilesDropped };

  useEffect(() => {
    let depth = 0;
    const reset = () => {
      depth = 0;
      setIsDragging(false);
    };
    const enter = (event: globalThis.DragEvent) => {
      if (!hasDraggedFiles(event)) return;
      depth++;
      setIsDragging(true);
    };
    const over = (event: globalThis.DragEvent) => {
      if (!hasDraggedFiles(event) || event.defaultPrevented) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = latest.current.canAttachMore ? "copy" : "none";
    };
    const leave = (event: globalThis.DragEvent) => {
      if (!hasDraggedFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDragging(false);
    };
    const drop = (event: globalThis.DragEvent) => {
      reset();
      if (!hasDraggedFiles(event) || event.defaultPrevented) return;
      event.preventDefault();
      latest.current.onFilesDropped(event.dataTransfer!.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragend", reset);
    };
  }, []);

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

  return { canAttachMore, isActive, isDragging, onDragEnter, onDragLeave, onDragOver, onDrop };
};
