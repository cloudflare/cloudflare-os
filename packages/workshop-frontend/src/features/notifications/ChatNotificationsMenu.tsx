import { useState } from "react";
import { DropdownMenu, useKumoToastManager } from "@cloudflare/kumo";
import { Bell, BellSlash } from "@phosphor-icons/react";
import type { Overseer } from "@gadgets/workshop-shared/api";
import { MENU_ITEM } from "../../components/menuStyles";
import { logRpcFailure } from "../../rpcErrors";

/** Per-user chat preference; the unread subscription supplies the saved value. */
export const ChatNotificationsMenu = ({ overseer, chatId, enabled, disabled }: {
  overseer: Pick<Overseer, "setChatNotificationsEnabled">;
  chatId: number;
  enabled: boolean;
  disabled: boolean;
}) => {
  const [saving, setSaving] = useState(false);
  const toasts = useKumoToastManager();
  const toggle = async () => {
    setSaving(true);
    try {
      await overseer.setChatNotificationsEnabled(chatId, !enabled);
    } catch (error) {
      logRpcFailure("Failed to update chat notifications:", error);
      toasts.add({ title: "Failed to update notifications", variant: "error" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <DropdownMenu.Item disabled={disabled || saving} onClick={() => { void toggle(); }} className={MENU_ITEM}>
      {enabled ? <BellSlash size={13} /> : <Bell size={13} />}
      {enabled ? "Mute notifications" : "Unmute notifications"}
    </DropdownMenu.Item>
  );
};
