import { useEffect, useState } from "react";
import type { ChatReadState } from "@gadgets/workshop-shared/api";
import { useAuthenticatedApi } from "../../AuthContext";
import { logRpcFailure } from "../../rpcErrors";

/** Refresh pre-upgrade index entries through the existing authorized workspace-open path. */
export const useUnreadPreviews = (chats: ChatReadState[]) => {
  const { authenticatedApi } = useAuthenticatedApi();
  const [failure, setFailure] = useState<{ api: typeof authenticatedApi; count: number }>();
  const [attempt, setAttempt] = useState(0);
  const workspaceIds = [...new Set(chats.filter(chat => chat.latestMessagePreview === undefined)
    .map(chat => chat.workspaceId))].toSorted().join("\n");

  useEffect(() => {
    let active = true;
    let failures = 0;
    const pending = workspaceIds ? workspaceIds.split("\n") : [];
    setFailure(undefined);
    // Workspace-open queues a durable backfill, but its ACK is not a projection-delivery receipt.
    // A delayed source or lost subscription must not leave the inbox loading indefinitely.
    const timeout = pending.length ? setTimeout(() => {
      if (active) setFailure({ api: authenticatedApi, count: pending.length || 1 });
    }, 15_000) : undefined;
    // Opening refreshes the durable projection; no chat history or read receipt is requested.
    const refresh = async () => {
      while (pending.length) {
        if (!active) return;
        const workspaceId = pending.shift()!;
        const workspace = authenticatedApi.openGadget(workspaceId);
        try {
          await workspace.getMetadata();
        } catch (cause) {
          failures++;
          logRpcFailure("Unread preview refresh failed:", cause);
        } finally {
          workspace[Symbol.dispose]();
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, refresh)).then(() => {
      if (active && failures) setFailure({ api: authenticatedApi, count: failures });
    });
    return () => { active = false; clearTimeout(timeout); };
  }, [authenticatedApi, workspaceIds, attempt]);

  return {
    failed: failure?.api === authenticatedApi && failure.count > 0,
    retry: () => setAttempt(value => value + 1),
  };
};
