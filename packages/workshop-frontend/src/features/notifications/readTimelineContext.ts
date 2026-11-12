import { createContext } from "react";

export const TimelineContext = createContext<{
  divider?: number;
  latestSequence: number;
  notificationsEnabled?: boolean;
  markUnread: (sequence: number) => void;
} | null>(null);
