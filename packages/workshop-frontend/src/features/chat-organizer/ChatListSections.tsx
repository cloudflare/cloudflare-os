import type { ReactNode } from "react";
import { CaretDown, PushPin } from "@phosphor-icons/react";
import type { AiChatMetadata } from "@gadgets/workshop-shared/api";
import { ChatFolderGroup } from "./ChatFolderGroup";
import type { OrganizedChats } from "./chatOrganization";
import { ChatStatusSummary } from "./ChatStatusSummary";
import type { ChatOrganizer } from "./useChatOrganizer";

/** An arranged chat list: Pinned, then each folder, then a hideable Other. */
export const ChatListSections = ({ sections, organizer, filtered, renderChat, renderOther }: {
  sections: OrganizedChats<AiChatMetadata>;
  organizer: ChatOrganizer;
  /** Whether a filter hides some conversations, so an empty folder may not really be empty. */
  filtered: boolean;
  /** Renders a pinned or foldered chat, which shows its own date. */
  renderChat: (chat: AiChatMetadata) => ReactNode;
  /** Renders Other's chats in the list's usual time groups. */
  renderOther: (chats: AiChatMetadata[]) => ReactNode;
}) => {
  const otherHidden = organizer.organization.otherHidden === true;

  return (
    <div className="flex flex-col gap-4">
      {sections.pinned.length > 0 && (
        <section className="flex flex-col gap-0.5">
          <p className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
            <PushPin size={11} weight="bold" />
            Pinned
          </p>
          {sections.pinned.map(renderChat)}
        </section>
      )}
      {sections.folders.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {sections.folders.map(({ folder, chats }) => (
            <ChatFolderGroup
              key={folder.id}
              folder={folder}
              chats={chats}
              organizer={organizer}
              filtered={filtered}
              renderChat={renderChat}
            />
          ))}
        </div>
      )}
      <section className="flex flex-col gap-2 border-t border-kumo-line pt-3">
        <button
          type="button"
          aria-expanded={!otherHidden}
          data-chat-other-toggle
          onClick={() => organizer.setOtherHidden(!otherHidden)}
          className="group flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-kumo-inactive transition-colors duration-150 ease-out hover:text-kumo-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-contrast"
        >
          <CaretDown
            size={10}
            weight="bold"
            className={`transition-transform duration-150 ease-out ${otherHidden ? "-rotate-90" : ""}`}
          />
          Other
          <span className="font-mono tracking-normal">{sections.other.length}</span>
          {otherHidden && <ChatStatusSummary chats={sections.other} />}
          <span className="ml-auto normal-case tracking-[-0.1px] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            {otherHidden ? "Show" : "Hide"}
          </span>
        </button>
        {!otherHidden && (sections.other.length > 0 ? renderOther(sections.other) : (
          <p className="px-1 text-[12px] leading-4 tracking-[-0.2px] text-kumo-inactive">
            Every conversation here is pinned or in a folder.
          </p>
        ))}
      </section>
    </div>
  );
};
