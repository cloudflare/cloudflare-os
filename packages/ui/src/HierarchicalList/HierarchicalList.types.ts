import type { ReactNode } from "react";

type HierarchicalListStandardItem = {
  id: string;
  name: string;
  appearance?: "default";
  icon?: ReactNode;
  /** Secondary text shown inline after the item name, truncating before the name does. */
  description?: ReactNode;
  metadata?: ReactNode;
  children?: readonly HierarchicalListItem[];
  draggable?: boolean;
  droppable?: boolean;
};

type HierarchicalListMessageItem = {
  id: string;
  name: string;
  /** Shows plain secondary text in a non-content row. */
  appearance: "message";
  /** Allows activation and standard interactive row feedback. */
  interactive?: boolean;
  icon?: never;
  description?: never;
  metadata?: never;
  children?: never;
  draggable?: never;
  droppable?: never;
};

/** One row in a hierarchical list. Defining `children` makes the row collapsible. */
export type HierarchicalListItem = HierarchicalListStandardItem | HierarchicalListMessageItem;

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
