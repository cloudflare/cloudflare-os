import { Banner } from "@cloudflare/kumo/components/banner";
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { NoticeProps } from "../index.ts";
import { disabledButtonProps } from "./Button.tsx";

/**
 * Info notices are not live regions themselves: {@link NoticeAnnouncer} speaks for them. Both tones
 * mark the message alone, so neither announces the action's label with it.
 */
export const Notice = ({ children, tone = "info", action }: NoticeProps) => (
  <Banner
    variant={tone === "error" ? "error" : "secondary"}
    size="sm"
    description={tone === "error"
      ? <span role="alert">{children as ReactNode}</span>
      : <span data-configurator-info-notice="">{children as ReactNode}</span>}
    action={action && <Banner.Action {...disabledButtonProps(action)}>{action.label}</Banner.Action>}
  />
);

/**
 * The one polite live region for info notices, holding the text of the last one on screen. A live
 * region is announced when its text changes, not when it is inserted with text already in it, so a
 * Notice that a step's render mounts would otherwise go unheard. Re-renders that leave the text as
 * it was announce nothing again.
 *
 * Renders with the form's root, and so after every render of the module's tree, which is the only
 * place Notices come from.
 */
export const NoticeAnnouncer = ({ form }: { form: RefObject<HTMLElement | null> }) => {
  const region = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const notices = form.current?.querySelectorAll("[data-configurator-info-notice]") ?? [];
    const text = notices[notices.length - 1]?.textContent ?? "";
    if (region.current && region.current.textContent !== text) region.current.textContent = text;
  });
  return <div ref={region} role="status" aria-live="polite" className="sr-only" />;
};
