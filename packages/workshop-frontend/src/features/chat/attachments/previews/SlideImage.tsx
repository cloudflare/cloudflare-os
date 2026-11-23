import type { CSSProperties } from "react";
import type { SlideImage as SlideImageData } from "@gadgets/office-content/pptx-slides";
import { useObjectUrl } from "../useObjectUrl";

/**
 * A picture from inside the presentation, drawn in an `<img>` from its own bytes: an SVG from a
 * data URL, which has no origin to run script as even when opened on its own, and any other
 * picture from an object URL (see useObjectUrl).
 */
export const SlideImage = ({ image, alt, style }: {
  image: SlideImageData;
  alt: string;
  style: CSSProperties;
}) => {
  const url = useObjectUrl(image.bytes, image.contentType);
  return url ? <img src={url} alt={alt} draggable={false} style={style} /> : null;
};
