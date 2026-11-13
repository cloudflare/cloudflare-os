import type { ReactNode } from "react";
import { readPptxSlides } from "@gadgets/office-content/pptx-slides";
import { derivedFrom } from "../derivedFrom";
import { assertOpenXml } from "./assertOpenXml";
import { SlideFrame } from "./SlideFrame";
import { ThumbnailStage } from "./ThumbnailStage";

/** Only the slide a card shows: the viewer reads the whole deck once it is opened. */
const readFirstSlide = (bytes: Uint8Array) => {
  assertOpenXml(bytes);
  return readPptxSlides(bytes, { maxSlides: 1 });
};

/** A deck's first slide, drawn card-sized; null for a deck with no slides. */
export const slideThumbnail = async (bytes: Uint8Array): Promise<ReactNode> => {
  const deck = await derivedFrom(bytes, readFirstSlide);
  const [slide] = deck.slides;
  if (!slide) return null;
  return (
    <ThumbnailStage>
      {(width) => <SlideFrame slide={slide} slideWidth={deck.width} slideHeight={deck.height} width={width} />}
    </ThumbnailStage>
  );
};
