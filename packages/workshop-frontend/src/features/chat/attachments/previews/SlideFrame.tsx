import { useEffect, useRef, useState } from "react";
import type { Slide } from "@gadgets/office-content/pptx-slides";
import { SlideImage } from "./SlideImage";
import { SlideShapeView } from "./SlideShapeView";
import { fillBackground } from "./slideStyles";

/**
 * One slide: a placeholder of the right shape until it nears the viewport, then its contents,
 * laid out at the slide's own size in points and scaled to the width it is shown at.
 */
export const SlideFrame = ({ slide, slideWidth, slideHeight, width }: {
  slide: Slide;
  slideWidth: number;
  slideHeight: number;
  width: number;
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNear(true);
        observer.disconnect();
      }
    }, { rootMargin: "100% 0px" });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const { background } = slide;
  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={`Slide ${slide.number}`}
      className="relative shrink-0 overflow-hidden bg-kumo-base shadow-sm ring-1 ring-kumo-line"
      style={{ width, height: Math.round(width * slideHeight / slideWidth) }}
    >
      {near && width > 0 && (
        <div
          // The app's text styles must not leak into the slide: everything here comes from the file.
          className="absolute left-0 top-0 origin-top-left text-left font-normal normal-case tracking-normal"
          style={{
            width: slideWidth,
            height: slideHeight,
            transform: `scale(${width / slideWidth})`,
            background: fillBackground(background),
          }}
        >
          {background.kind === "image" && (
            <SlideImage image={background.image} alt="" style={{ position: "absolute", width: "100%", height: "100%" }} />
          )}
          {slide.shapes.map((shape, index) => <SlideShapeView key={index} shape={shape} />)}
        </div>
      )}
    </div>
  );
};
