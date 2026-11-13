import type { CSSProperties } from "react";
import type { SlideImage as SlideImageData } from "@gadgets/office-content/pptx-slides";
import { useObjectUrl } from "../useObjectUrl";

/**
 * A picture from inside the presentation. It is drawn from an object URL of its bytes in an
 * `<img>`, where an SVG cannot run script or load anything.
 */
export const SlideImage = ({ image, alt, style }: {
  image: SlideImageData;
  alt: string;
  style: CSSProperties;
}) => {
  const url = useObjectUrl(image.bytes, image.contentType);
  return url ? <img src={url} alt={alt} draggable={false} style={style} /> : null;
};
