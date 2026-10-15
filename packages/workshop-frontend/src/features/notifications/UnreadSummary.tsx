import { Chats } from "@phosphor-icons/react";
import SidebarItem from "../../components/AppShell/SidebarItem";
import { useUnreadState } from "./UnreadStateBridge";
import { UnreadBadge } from "./UnreadBadge";

/** Navigation to every unread thread, including workspaces outside the Recent list. */
export const UnreadSummary = ({ collapsed }: { collapsed: boolean }) => {
  const unread = useUnreadState();
  return (
    <SidebarItem
      to="/unread"
      label="Unread threads"
      icon={<Chats size={14} weight="regular" />}
      trailing={<UnreadBadge count={unread?.state?.unreadChatCount ?? 0} />}
      collapsed={collapsed}
    />
  );
};
