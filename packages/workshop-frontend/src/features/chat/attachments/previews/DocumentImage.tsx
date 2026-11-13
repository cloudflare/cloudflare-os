import type { DocxImage } from "@gadgets/office-content/docx-document";
import { useObjectUrl } from "../useObjectUrl";
import { borderStyle, pt } from "./documentStyles";

/**
 * A picture from the document at the size the document gives it. Its bytes are shown through an
 * object URL, so nothing the file names is ever fetched.
 */
export const DocumentImage = ({ image }: { image: DocxImage }) => {
  const url = useObjectUrl(image.bytes, image.contentType);
  const box = {
    display: "inline-block",
    width: pt(image.width),
    maxWidth: "100%",
    height: "auto",
    aspectRatio: `${image.width} / ${image.height}`,
    border: borderStyle(image.outline),
    borderRadius: image.cornerRadius === undefined ? undefined : pt(image.cornerRadius),
    verticalAlign: "baseline",
  };
  return url
    ? <img src={url} alt={image.description ?? ""} style={box} />
    : <span style={box} />;
};
