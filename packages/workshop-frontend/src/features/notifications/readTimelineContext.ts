import { createContext } from "react";

export const TimelineContext = createContext<{
  divider?: number;
  latestSequence: number;
  markUnread: (sequence: number) => void;
} | null>(null);
