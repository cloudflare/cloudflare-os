import { Tooltip } from "@cloudflare/kumo";
import type { AiChatMetadata } from "@gadgets/workshop-shared/api";
import { countChatStatuses } from "./chatOrganization";

/** For a collapsed section's header: how many of its chats are working or have pending changes. */
export const ChatStatusSummary = ({ chats }: { chats: readonly AiChatMetadata[] }) => {
  const { working, pending } = countChatStatuses(chats);
  if (working === 0 && pending === 0) return null;

  return (
    <span className="flex flex-shrink-0 items-center gap-2 text-[11px] leading-4 font-medium normal-case tracking-normal">
      {working > 0 && (
        <span className="inline-flex items-center gap-1 text-kumo-brand">
          <span className="h-1.5 w-1.5 rounded-full bg-kumo-brand animate-pulse" />
          {working} working
        </span>
      )}
      {pending > 0 && (
        // Kept short so a folder's name still fits beside it on a phone.
        <Tooltip content={pending === 1 ? "1 conversation has pending changes" : `${pending} conversations have pending changes`} asChild>
          <span className="inline-flex items-center gap-1 text-kumo-warning">
            <span className="h-1.5 w-1.5 rounded-full bg-kumo-warning" />
            {pending} pending
          </span>
        </Tooltip>
      )}
    </span>
  );
};
