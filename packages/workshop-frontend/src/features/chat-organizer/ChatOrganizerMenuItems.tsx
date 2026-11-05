import { DropdownMenu } from "@cloudflare/kumo";
import {
  ArrowUUpLeft,
  Check,
  FolderSimple,
  FolderSimplePlus,
  PushPin,
  PushPinSlash,
} from "@phosphor-icons/react";
import { MENU_POSITIONER_STYLE } from "../../components/menuStyles";
import { PINNED, folderOfChat } from "./chatOrganization";
import type { ChatOrganizer } from "./useChatOrganizer";

// Matches the chat row menu these items join.
const ITEM =
  "!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint data-popup-open:bg-kumo-tint";

/** Pin and Move to folder, for the top of a chat row's actions menu. */
export const ChatOrganizerMenuItems = ({ chatId, organizer }: {
  chatId: number;
  organizer: ChatOrganizer;
}) => {
  const { organization } = organizer;
  const pinned = organization.places[chatId] === PINNED;
  const currentFolder = folderOfChat(organization, chatId);

  // Moving a chat to another section re-creates its row, so the menu's own trigger is gone by the
  // time it would return focus there. Give it to the moved row's actions button instead, or to
  // Other's toggle when the row went into a hidden Other.
  const move = (change: () => void) => {
    change();
    requestAnimationFrame(() =>
      (document.querySelector<HTMLElement>(`[data-chat-actions="${chatId}"]`)
        ?? document.querySelector<HTMLElement>("[data-chat-other-toggle]"))?.focus());
  };

  return (
    <>
      <DropdownMenu.Item
        icon={pinned ? <PushPinSlash className="size-3" /> : <PushPin className="size-3" />}
        onClick={() => move(() => (pinned ? organizer.moveToOther(chatId) : organizer.pin(chatId)))}
        className={ITEM}
      >
        {pinned ? "Unpin" : "Pin to top"}
      </DropdownMenu.Item>
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger icon={<FolderSimple className="size-3" />} className={ITEM}>
          Move to folder
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent
          className="themed-floating-shadow !z-[1100] !min-w-[168px] rounded-lg border border-kumo-line bg-kumo-base p-1"
          style={MENU_POSITIONER_STYLE}
        >
          {organization.folders.map((folder) => (
            <DropdownMenu.Item
              key={folder.id}
              icon={folder.id === currentFolder?.id
                ? <Check className="size-3" weight="bold" />
                : <FolderSimple className="size-3" />}
              onClick={() => move(() => organizer.moveToFolder(chatId, folder.id))}
              className={ITEM}
            >
              <span className="truncate">{folder.name}</span>
            </DropdownMenu.Item>
          ))}
          {organization.folders.length > 0 && <DropdownMenu.Separator />}
          <DropdownMenu.Item
            icon={<FolderSimplePlus className="size-3" />}
            onClick={() => organizer.createFolder(chatId)}
            className={ITEM}
          >
            New folder
          </DropdownMenu.Item>
          {currentFolder && (
            <DropdownMenu.Item
              icon={<ArrowUUpLeft className="size-3" />}
              onClick={() => move(() => organizer.moveToOther(chatId))}
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
