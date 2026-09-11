import type { ReactNode } from "react";

/** One row in a hierarchical list. Defining `children` makes the row collapsible. */
export type HierarchicalListItem = {
  id: string;
  name: string;
  icon?: ReactNode;
  metadata?: ReactNode;
  children?: readonly HierarchicalListItem[];
  draggable?: boolean;
  droppable?: boolean;
};

/** Controlled or uncontrolled expansion configuration for a hierarchical list. */
export type HierarchicalListExpansionProps =
  | {
      expandedIds: ReadonlySet<string>;
      onExpandedChange: (expandedIds: ReadonlySet<string>) => void;
      initialExpandedIds?: never;
    }
  | {
      expandedIds?: never;
      onExpandedChange?: never;
      initialExpandedIds?: Iterable<string>;
    };
