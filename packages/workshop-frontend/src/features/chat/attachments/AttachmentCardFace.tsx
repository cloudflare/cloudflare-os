import { SkeletonLine } from "@cloudflare/kumo";
import type { AttachmentKind } from "./attachmentKind";
import { ATTACHMENT_KIND_ICONS } from "./attachmentKindIcons";
import type { AttachmentThumbnail } from "./useAttachmentThumbnail";

const NAME_CLASS =
  "break-words text-[11px] font-medium leading-[14px] text-kumo-default sm:text-[12px] sm:leading-4";

/**
 * What a card shows for a file that is not itself a picture: a glimpse of its content when there
 * is a thumbnail, the shimmer an uploading card has while one is being made, and its kind's icon
 * above its name when there is none.
 */
export const AttachmentCardFace = ({ name, kind, thumbnail, loading }: {
  name: string;
  kind: AttachmentKind;
  thumbnail: AttachmentThumbnail | null;
  loading: boolean;
}) => {
  const KindIcon = ATTACHMENT_KIND_ICONS[kind];
  if (!thumbnail && loading) {
    return <SkeletonLine minWidth={100} maxWidth={100} className="h-full w-full" />;
  }
  if (!thumbnail) {
    return (
      <span className="flex h-full flex-col justify-between p-2.5 sm:p-3">
        <KindIcon size={20} className="text-kumo-default" />
        <span className={`line-clamp-2 ${NAME_CLASS}`}>{name}</span>
      </span>
    );
  }
  // Like an image, a thumbnail fills its card; the card's tooltip and label carry the name.
  if (thumbnail.type === "image") {
    return (
      <img
        src={thumbnail.url}
        alt=""
        className={`block h-full w-full bg-kumo-base ${thumbnail.whole ? "object-contain" : "object-cover object-top"}`}
      />
    );
  }
  if (thumbnail.type === "view") {
    return <div className="h-full w-full bg-kumo-base">{thumbnail.view}</div>;
  }
  return (
    // Too small to read by design: it shows the shape of the text, as a page seen from afar.
    <span
      aria-hidden="true"
      className="block h-full select-none overflow-hidden whitespace-pre bg-kumo-base px-2 pt-2 font-mono text-[5px] leading-[7px] text-kumo-subtle"
    >
      {thumbnail.text}
    </span>
  );
};
