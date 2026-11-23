import type { CSSProperties } from "react";
import type {
  SlideDrawnShape, SlideGeometry, SlideOutline, SlidePicture, SlideShape, SlideUnsupportedKind,
} from "@gadgets/office-content/pptx-slides";
import { SlideImage } from "./SlideImage";
import { SlideTable } from "./SlideTable";
import { SlideText } from "./SlideText";
import { boundsStyle, fillBackground, strokeProps } from "./slideStyles";

const UNSUPPORTED_LABELS: Record<SlideUnsupportedKind, string> = {
  chart: "Chart",
  diagram: "SmartArt",
  object: "Embedded object",
  picture: "Picture",
};

const ANCHOR = { top: "flex-start", middle: "center", bottom: "flex-end" } as const;
const NOWRAP_ALIGN = { left: "flex-start", center: "center", right: "flex-end", justify: "flex-start" } as const;
const WRITING_MODE = { horizontal: undefined, rotate90: "vertical-rl", rotate270: "sideways-lr" } as const;

const cornerStyle = (geometry: SlideGeometry, cornerRadius: number): CSSProperties => ({
  borderRadius: geometry === "ellipse" ? "50%" : geometry === "roundRect" ? cornerRadius : undefined,
});

const flipTransform = (flipH: boolean, flipV: boolean): string | undefined =>
  flipH || flipV ? `scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})` : undefined;

/** The outline as SVG, because a stroke straddles the edge where a CSS border sits inside it. */
const Outline = ({ geometry, cornerRadius, width, height, outline }: {
  geometry: SlideGeometry;
  cornerRadius: number;
  width: number;
  height: number;
  outline: SlideOutline;
}) => (
  <svg
    aria-hidden="true"
    width={width}
    height={height}
    style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}
  >
    {geometry === "line" ? (
      <line x1={0} y1={0} x2={width} y2={height} {...strokeProps(outline)} />
    ) : geometry === "ellipse" ? (
      <ellipse cx={width / 2} cy={height / 2} rx={width / 2} ry={height / 2} fill="none" {...strokeProps(outline)} />
    ) : (
      <rect width={width} height={height} rx={geometry === "roundRect" ? cornerRadius : 0} fill="none" {...strokeProps(outline)} />
    )}
  </svg>
);

const DrawnShape = ({ shape }: { shape: SlideDrawnShape }) => {
  const { bounds, text, fill, outline } = shape;
  const corners = cornerStyle(shape.geometry, shape.cornerRadius);
  return (
    <div style={boundsStyle(bounds)}>
      {/* Flips mirror the geometry only: PowerPoint keeps a mirrored shape's text readable. */}
      <div style={{ position: "absolute", inset: 0, transform: flipTransform(bounds.flipH, bounds.flipV) }}>
        {fill?.kind === "image" ? (
          <SlideImage image={fill.image} alt="" style={{ position: "absolute", width: "100%", height: "100%", ...corners }} />
        ) : fill && shape.geometry !== "line" && (
          <div style={{ position: "absolute", inset: 0, background: fillBackground(fill), ...corners }} />
        )}
        {outline && (
          <Outline
            geometry={shape.geometry}
            cornerRadius={shape.cornerRadius}
            width={bounds.width}
            height={bounds.height}
            outline={outline}
          />
        )}
      </div>
      {text && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            justifyContent: ANCHOR[text.anchor],
            alignItems: text.wrap ? "stretch" : NOWRAP_ALIGN[text.paragraphs[0]?.align ?? "left"],
            padding: `${text.insets.top}px ${text.insets.right}px ${text.insets.bottom}px ${text.insets.left}px`,
            writingMode: WRITING_MODE[text.direction],
            transform: bounds.flipV ? "rotate(180deg)" : undefined,
          }}
        >
          <SlideText body={text} />
        </div>
      )}
    </div>
  );
};

const Picture = ({ picture }: { picture: SlidePicture }) => {
  const { bounds, crop } = picture;
  // A crop that leaves nothing would divide by zero; such a picture is drawn uncropped.
  const cropped = crop.left + crop.right < 1 && crop.top + crop.bottom < 1;
  const left = cropped ? crop.left : 0;
  const top = cropped ? crop.top : 0;
  const shownWidth = cropped ? 1 - crop.left - crop.right : 1;
  const shownHeight = cropped ? 1 - crop.top - crop.bottom : 1;
  return (
    <div style={boundsStyle(bounds)}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          transform: flipTransform(bounds.flipH, bounds.flipV),
          ...cornerStyle(picture.geometry, picture.cornerRadius),
        }}
      >
        <SlideImage
          image={picture.image}
          alt={picture.description ?? ""}
          style={{
            position: "absolute",
            maxWidth: "none",
            width: `${100 / shownWidth}%`,
            height: `${100 / shownHeight}%`,
            left: `${(-left / shownWidth) * 100}%`,
            top: `${(-top / shownHeight) * 100}%`,
          }}
        />
      </div>
      {picture.outline && (
        <Outline
          geometry={picture.geometry}
          cornerRadius={picture.cornerRadius}
          width={bounds.width}
          height={bounds.height}
          outline={picture.outline}
        />
      )}
    </div>
  );
};

/** One thing on a slide, drawn in the slide's own coordinates (points). */
export const SlideShapeView = ({ shape }: { shape: SlideShape }) => {
  switch (shape.kind) {
    case "shape":
      return <DrawnShape shape={shape} />;
    case "picture":
      return <Picture picture={shape} />;
    case "table":
      return <SlideTable table={shape} />;
    case "unsupported":
      return (
        <div
          style={boundsStyle(shape.bounds)}
          className="flex items-center justify-center overflow-hidden border border-dashed border-kumo-line bg-kumo-elevated text-[14px] text-kumo-subtle"
        >
          {UNSUPPORTED_LABELS[shape.what]}
        </div>
      );
  }
};
