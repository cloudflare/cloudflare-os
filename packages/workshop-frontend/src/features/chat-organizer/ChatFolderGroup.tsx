import { useState, type ReactNode } from "react";
import { DropdownMenu } from "@cloudflare/kumo";
import { CaretDown, DotsThreeVertical, FolderSimple, Pencil, Trash } from "@phosphor-icons/react";
import type { AiChatMetadata } from "@gadgets/workshop-shared/api";
import DeleteConfirmationDialog from "../../components/DeleteConfirmationDialog";
import { WorkshopIconButton } from "../../components/WorkshopControls";
import { ChatStatusSummary } from "./ChatStatusSummary";
import { FolderNameInput } from "./FolderNameInput";
import type { ChatOrganizer } from "./useChatOrganizer";

/** A collapsible folder in the chat list: its header, actions, and chats. */
export const ChatFolderGroup = ({ name, chats, organizer, unreadCount, renderChat }: {
  name: string;
  chats: readonly AiChatMetadata[];
  organizer: ChatOrganizer;
  unreadCount: (chatId: number) => number;
  renderChat: (chat: AiChatMetadata) => ReactNode;
}) => {
  const renaming = organizer.renamingFolder === name;
  const open = !organizer.view.collapsedFolders.includes(name);
  const [deleteState, setDeleteState] = useState<"confirming" | "deleting" | null>(null);

  const deleteFolder = async () => {
    setDeleteState("deleting");
    await organizer.deleteFolder(name);
    setDeleteState(null);
  };

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
              initialName={name}
              onDone={(newName) => void organizer.finishNaming(newName)}
            />
          </div>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={open}
              data-chat-folder={name}
              onClick={() => organizer.toggleFolder(name)}
              className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg pl-2.5 text-left text-kumo-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-contrast"
            >
              <CaretDown
                size={10}
                weight="bold"
                className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "" : "-rotate-90"}`}
              />
              <FolderSimple size={14} className="flex-shrink-0" />
              <span className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                {name}
              </span>
              <span className="flex-shrink-0 font-mono text-[11px] text-kumo-inactive">{chats.length}</span>
              {!open && <ChatStatusSummary chats={chats} unreadCount={unreadCount} />}
            </button>
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <WorkshopIconButton
                    aria-label={`Actions for folder ${name}`}
                    className="!h-9 !w-9 flex-shrink-0 text-kumo-inactive opacity-100 focus:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100 sm:!h-7 sm:!w-7 sm:opacity-0"
                  >
                    <DotsThreeVertical size={14} />
                  </WorkshopIconButton>
                }
              />
              <DropdownMenu.Content className="themed-floating-shadow !z-[1100] !min-w-[144px] rounded-lg border border-kumo-line bg-kumo-base p-1">
                <DropdownMenu.Item
                  icon={<Pencil className="size-3" />}
                  onClick={() => organizer.startRenamingFolder(name)}
                  className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
                >
                  Rename
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  icon={<Trash className="size-3" />}
                  variant="danger"
                  onClick={() => setDeleteState("confirming")}
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
          {chats.map(renderChat)}
        </div>
      )}
      <DeleteConfirmationDialog
        open={deleteState !== null}
        title="Delete folder?"
        description={<>This removes <span className="font-medium text-kumo-default">{name}</span> for everyone in this workspace. Its conversations move to Other; they aren&apos;t deleted.</>}
        isDeleting={deleteState === "deleting"}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeleteState(null);
        }}
        onConfirm={() => void deleteFolder()}
      />
    </div>
  );
};
