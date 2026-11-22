import { useState } from "react";
import { DropdownMenu, useKumoToastManager } from "@cloudflare/kumo";
import { Bell, BellSlash } from "@phosphor-icons/react";
import type { Overseer } from "@gadgets/workshop-shared/api";
import { MENU_ITEM } from "../../components/menuStyles";
import { logRpcFailure } from "../../rpcErrors";

/** Per-user chat preference; the unread subscription supplies the saved value. */
export const ChatNotificationsMenu = ({ overseer, chatId, enabled, override, disabled }: {
  overseer: Pick<Overseer, "setChatNotificationsEnabled">;
  chatId: number;
  enabled: boolean;
  override?: boolean;
  disabled: boolean;
}) => {
  const [saving, setSaving] = useState(false);
  const toasts = useKumoToastManager();
  const update = async (value: boolean) => {
    setSaving(true);
    try {
      await overseer.setChatNotificationsEnabled(chatId, value);
    } catch (error) {
      logRpcFailure("Failed to update chat notifications:", error);
      toasts.add({ title: "Failed to update notifications", variant: "error" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      {!enabled && <DropdownMenu.Item disabled={disabled || saving}
        onClick={() => { void update(true); }} className={MENU_ITEM}>
        <Bell size={13} />
        {override === false ? "Unmute notifications" : "Enable notifications"}
      </DropdownMenu.Item>}
      {(enabled || override !== false) && <DropdownMenu.Item disabled={disabled || saving}
        onClick={() => { void update(false); }} className={MENU_ITEM}>
        <BellSlash size={13} />
        Mute notifications
      </DropdownMenu.Item>}
    </>
  );
};
