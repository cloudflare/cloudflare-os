import type { ReactNode } from "react";
import { derivedFrom } from "../derivedFrom";
import { SlideFrame } from "./SlideFrame";
import { readDeck } from "./SlidesPreview";
import { ThumbnailStage } from "./ThumbnailStage";

/** A deck's first slide, drawn card-sized; null for a deck with no slides. */
export const slideThumbnail = async (bytes: Uint8Array): Promise<ReactNode> => {
  const deck = await derivedFrom(bytes, readDeck);
  const [slide] = deck.slides;
  if (!slide) return null;
  return (
    <ThumbnailStage>
      {(width) => <SlideFrame slide={slide} slideWidth={deck.width} slideHeight={deck.height} width={width} />}
    </ThumbnailStage>
  );
};
