import { Banner } from "@cloudflare/kumo/components/banner";
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { NoticeProps } from "../index.ts";

/** Info notices are not live regions themselves: {@link NoticeAnnouncer} speaks for them. */
export const Notice = ({ children, tone = "info" }: NoticeProps) => tone === "error"
  ? <Banner variant="error" size="sm" role="alert" description={children as ReactNode} />
  : <Banner variant="secondary" size="sm" data-configurator-info-notice="" description={children as ReactNode} />;

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
