import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { useAuthenticatedApi } from "../../AuthContext";
import { useServerConfig } from "../../ServerConfigContext";
import { logRpcFailure } from "../../rpcErrors";
import { browserPushSupport, syncBrowserPush } from "./browserPush";

/** Keeps this browser's push with the signed-in user, and opens the chat a notification names. */
export const BrowserPushBridge = () => {
  const { authenticatedApi, currentUser, isCurrentUserConfirmed } = useAuthenticatedApi();
  const publicKey = useServerConfig()?.webPushPublicKey;
  const router = useRouter();
  const syncedUserId = useRef<string>(undefined);
  // Mid-reconnect, currentUser can still be the previous account while the API is the next one's,
  // which would register this browser for the wrong account.
  const confirmedUserId = isCurrentUserConfirmed ? currentUser?.id : undefined;

  useEffect(() => {
    // Once per user per page load, not per reconnect: each sync costs a central registration, and
    // every reconnect re-confirms. A failed sync is retried on the next reconnect, or a long-lived
    // tab would stay unregistered.
    if (!confirmedUserId || confirmedUserId === syncedUserId.current || !publicKey ||
        browserPushSupport() !== "supported") return;
    syncedUserId.current = confirmedUserId;
    syncBrowserPush(authenticatedApi, confirmedUserId).catch(error => {
      if (syncedUserId.current === confirmedUserId) syncedUserId.current = undefined;
      logRpcFailure("Failed to refresh browser notifications:", error);
    });
  }, [authenticatedApi, confirmedUserId, publicKey]);

  useEffect(() => {
    let onMessage = (event: MessageEvent) => {
      if (event.data?.type === "cloudflare-os:open-notification") {
        void router.navigate({ href: event.data.path });
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [router]);

  return null;
};
