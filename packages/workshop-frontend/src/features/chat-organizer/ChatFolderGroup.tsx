import { useRef, type ReactNode } from "react";
import { DropdownMenu } from "@cloudflare/kumo";
import { CaretDown, DotsThreeVertical, FolderSimple, Pencil, Trash } from "@phosphor-icons/react";
import type { AiChatMetadata } from "@gadgets/workshop-shared/api";
import { WorkshopIconButton } from "../../components/WorkshopControls";
import { isImeComposing } from "../../keyboardEvent";
import type { ChatFolder } from "./chatOrganization";
import { ChatStatusSummary } from "./ChatStatusSummary";
import type { ChatOrganizer } from "./useChatOrganizer";

const FolderNameInput = ({ name, onDone }: {
  name: string;
  onDone: (name: string | null) => void;
}) => {
  // Enter and Escape unmount the input, which can then report a blur too; only the first counts.
  const doneRef = useRef(false);
  const finish = (value: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(value);
  };

  return (
    <input
      type="text"
      defaultValue={name}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (isImeComposing(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      spellCheck={false}
      autoComplete="off"
      aria-label="Folder name"
      className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default outline-none"
    />
  );
};

/** A collapsible folder in the chat list: its header, actions, and chats. */
export const ChatFolderGroup = ({ folder, chats, organizer, filtered, renderChat }: {
  folder: ChatFolder;
  chats: readonly AiChatMetadata[];
  organizer: ChatOrganizer;
  filtered: boolean;
  renderChat: (chat: AiChatMetadata) => ReactNode;
}) => {
  const renaming = organizer.renamingFolderId === folder.id;
  const open = !folder.collapsed;

  return (
    <div className="flex flex-col">
      <div
        className={`group flex h-9 items-center gap-1 rounded-lg pr-1 transition-[background-color] duration-150 ease-out ${
          renaming ? "bg-kumo-base ring-1 ring-kumo-ring/40" : "hover:bg-kumo-tint"
        }`}
      >
        {renaming ? (
          // Indented past the caret so the folder icon stays where it was.
          <div className="flex min-w-0 flex-1 items-center gap-2 pl-7">
            <FolderSimple size={14} className="flex-shrink-0 text-kumo-subtle" />
            <FolderNameInput
              name={folder.name}
              onDone={(name) => organizer.finishRenamingFolder(folder.id, name)}
            />
          </div>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => organizer.toggleFolder(folder.id)}
              className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg pl-2.5 text-left text-kumo-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-contrast"
            >
              <CaretDown
                size={10}
                weight="bold"
                className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "" : "-rotate-90"}`}
              />
              <FolderSimple size={14} className="flex-shrink-0" />
              <span className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                {folder.name}
              </span>
              <span className="flex-shrink-0 font-mono text-[11px] text-kumo-inactive">{chats.length}</span>
              {!open && <ChatStatusSummary chats={chats} />}
            </button>
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <WorkshopIconButton
                    aria-label={`Actions for folder ${folder.name}`}
                    className="!h-9 !w-9 flex-shrink-0 text-kumo-inactive opacity-100 focus:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100 sm:!h-7 sm:!w-7 sm:opacity-0"
                  >
                    <DotsThreeVertical size={14} />
                  </WorkshopIconButton>
                }
              />
              <DropdownMenu.Content className="themed-floating-shadow !z-[1100] !min-w-[144px] rounded-lg border border-kumo-line bg-kumo-base p-1">
                <DropdownMenu.Item
                  icon={<Pencil className="size-3" />}
                  onClick={() => organizer.startRenamingFolder(folder.id)}
                  className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
                >
                  Rename
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  icon={<Trash className="size-3" />}
                  variant="danger"
                  onClick={() => organizer.deleteFolder(folder.id)}
                  className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] transition-colors data-highlighted:bg-kumo-danger-tint"
                >
                  Delete folder
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          </>
        )}
      </div>
      {open && (
        <div className="ml-4 mt-0.5 flex flex-col gap-0.5 border-l border-kumo-line pl-1.5">
          {chats.length > 0 ? chats.map(renderChat) : (
            <p className="px-2.5 py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-inactive">
              {filtered
                ? "No conversations here match this filter."
                : "Move conversations here from their actions menu."}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
