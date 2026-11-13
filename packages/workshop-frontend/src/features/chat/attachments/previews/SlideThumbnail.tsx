import type { ReactNode } from "react";
import { assertOpenXml } from "./assertOpenXml";
import { readOffice } from "./officeReader";
import { SlideFrame } from "./SlideFrame";
import { ThumbnailStage } from "./ThumbnailStage";


/** A deck's first slide, drawn card-sized; null for a deck with no slides. */
export const slideThumbnail = async (bytes: Uint8Array, signal: AbortSignal): Promise<ReactNode> => {
  assertOpenXml(bytes);
  // Only the slide a card shows: the viewer reads the whole deck once it is opened.
  const deck = await readOffice("slides", bytes, { maxSlides: 1 }, signal);
  const [slide] = deck.slides;
  if (!slide) return null;
  return (
    <ThumbnailStage>
      {(width) => <SlideFrame slide={slide} slideWidth={deck.width} slideHeight={deck.height} width={width} />}
    </ThumbnailStage>
  );
};
