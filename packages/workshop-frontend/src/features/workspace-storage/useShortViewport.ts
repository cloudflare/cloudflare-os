import { useSyncExternalStore } from "react";

// The visible height, a phone keyboard's share taken out, at or under which the workspace has no
// height to spare: the composer and the bars above it fill it, in a pane that clips its overflow,
// so anything more pushes Send off screen. The height styles.css treats as a short window too.
const SHORT_VIEWPORT_HEIGHT = 520;

const subscribe = (onChange: () => void) => {
  window.visualViewport?.addEventListener("resize", onChange);
  window.addEventListener("resize", onChange);
  return () => {
    window.visualViewport?.removeEventListener("resize", onChange);
    window.removeEventListener("resize", onChange);
  };
};

const isShortViewport = () =>
  (window.visualViewport?.height ?? window.innerHeight) <= SHORT_VIEWPORT_HEIGHT;

/** Whether the visible part of the page is too short for the workspace to give up any height. */
export const useShortViewport = () => useSyncExternalStore(subscribe, isShortViewport);
