import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The part of a card a file's own rendering is drawn in, at whatever width the card gives it.
 * What is drawn is a picture of the file, not a way to use it: it takes no focus or clicks and
 * is hidden from assistive tech, which has the card's name.
 */
export const ThumbnailStage = ({ children }: { children: (width: number) => ReactNode }) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={stageRef} inert aria-hidden="true" className="grid h-full w-full place-items-center overflow-hidden">
      {width > 0 && children(width)}
    </div>
  );
};
