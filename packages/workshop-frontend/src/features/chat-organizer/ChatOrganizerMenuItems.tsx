import { DropdownMenu } from "@cloudflare/kumo";
import {
  ArrowUUpLeft,
  Check,
  FolderSimple,
  FolderSimplePlus,
  PushPin,
  PushPinSlash,
} from "@phosphor-icons/react";
import type { AiChatMetadata } from "@gadgets/workshop-shared/api";
import { MENU_POSITIONER_STYLE } from "../../components/menuStyles";
import type { ChatOrganizer } from "./useChatOrganizer";

// Matches the chat row menu these items join.
const ITEM =
  "!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint data-popup-open:bg-kumo-tint";

/** Pin and Move to folder, for the top of a chat row's actions menu. */
export const ChatOrganizerMenuItems = ({ chat, organizer }: {
  chat: AiChatMetadata;
  organizer: ChatOrganizer;
}) => {
  return (
    <>
      <DropdownMenu.Item
        icon={chat.pinned ? <PushPinSlash className="size-3" /> : <PushPin className="size-3" />}
        onClick={() => void (chat.pinned ? organizer.unpin(chat.id) : organizer.pin(chat.id))}
        className={ITEM}
      >
        {chat.pinned ? "Unpin" : "Pin to top"}
      </DropdownMenu.Item>
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger icon={<FolderSimple className="size-3" />} className={ITEM}>
          Move to folder
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent
          className="themed-floating-shadow !z-[1100] !min-w-[168px] rounded-lg border border-kumo-line bg-kumo-base p-1"
          style={MENU_POSITIONER_STYLE}
        >
          {organizer.folderNames.map((folder) => (
            <DropdownMenu.Item
              key={folder}
              icon={folder === chat.folder
                ? <Check className="size-3" weight="bold" />
                : <FolderSimple className="size-3" />}
              onClick={() => void organizer.moveToFolder(chat, folder)}
              className={ITEM}
            >
              <span className="truncate">{folder}</span>
            </DropdownMenu.Item>
          ))}
          {organizer.folderNames.length > 0 && <DropdownMenu.Separator />}
          <DropdownMenu.Item
            icon={<FolderSimplePlus className="size-3" />}
            onClick={() => organizer.startNewFolder(chat)}
            className={ITEM}
          >
            New folder…
          </DropdownMenu.Item>
          {chat.folder !== undefined && (
            <DropdownMenu.Item
              icon={<ArrowUUpLeft className="size-3" />}
              onClick={() => void organizer.removeFromFolder(chat.id)}
              className={ITEM}
            >
              Remove from folder
            </DropdownMenu.Item>
          )}
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>
      <DropdownMenu.Separator />
    </>
  );
};
