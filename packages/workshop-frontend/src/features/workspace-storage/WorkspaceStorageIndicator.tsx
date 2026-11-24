import { useState } from "react";
import { Popover } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { WorkshopIconButton } from "../../components/WorkshopControls";
import { storageNotice } from "./storageNotice";
import { useShortViewport } from "./useShortViewport";

/**
 * WorkspaceStorageBanner's warning as a top-bar button, for a window too short to give the
 * banner its height, as a phone is with its keyboard open: it opens to the banner's details. Open,
 * or holding focus, it stays though the window grows, as it does when opening it closes the
 * keyboard, so closing it returns focus to it; the banner takes over after.
 */
export const WorkspaceStorageIndicator = ({ storageBytes }: { storageBytes: number }) => {
  const short = useShortViewport();
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  if (!short && !open && !focused) return null;
  const notice = storageNotice(storageBytes);
  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        setOpen(next);
        // Escape hands focus back to the button, which must still be there to take it.
        if (!next && details.reason === "escape-key") setFocused(true);
      }}
    >
      <Popover.Trigger
        render={(
          <WorkshopIconButton
            aria-label={notice.title}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          >
            <WarningIcon
              size={16}
              weight="bold"
              className={notice.variant === "error" ? "text-kumo-danger" : "text-kumo-warning"}
            />
          </WorkshopIconButton>
        )}
      />
      <Popover.Content
        align="end"
        sideOffset={8}
        positionMethod="fixed"
        className="!z-[1100] !w-[min(320px,calc(100vw-24px))]"
      >
        <Popover.Title>{notice.title}</Popover.Title>
        <Popover.Description>{notice.description}</Popover.Description>
      </Popover.Content>
    </Popover>
  );
};
