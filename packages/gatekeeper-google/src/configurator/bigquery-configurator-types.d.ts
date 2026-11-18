import type { ConfiguratorOption } from "./configurator-option";
export type { ConfiguratorOption };

/**
 * The chosen node, by its {@link BigQueryNode.id}, or null when nothing is chosen; and the project
 * query jobs run in when the node's project is not one this account holds a role in (see
 * {@link BigQueryNode.listed}), else null.
 */
export type BigQueryConfiguratorValues = { target?: string | null; queryProject?: string | null };

export type BigQueryNodeKind = "project" | "dataset" | "table";

/** A project, dataset or table the picker shows. */
export type BigQueryNode = {
  /**
   * `project:<projectId>`, `dataset:<projectId>/<datasetId>` or
   * `table:<projectId>/<datasetId>/<tableId>`. A project ID never holds "/", and dataset and table
   * IDs are BigQuery identifiers, so the segments split unambiguously.
   */
  id: string;
  kind: BigQueryNodeKind;
  title: string;
  /** A project's or dataset's friendly name (or a dataset's description); a table's friendly name, or its kind when it is not a plain table. */
  subtitle?: string;
  /** Set on a table that is a view or materialized view. */
  view?: true;
  /**
   * Whether the node's project is one BigQuery lists for this account: the projects it holds a role
   * in, where it can usually run query jobs. A dataset shared from another project is reached by
   * ID instead, and a connection to it names a listed project to run its queries in.
   */
  listed: boolean;
  /** The node's ancestors below the root, outermost first, for a node looked up or found by search. */
  path?: BigQueryCrumb[];
};

export type BigQueryCrumb = Pick<BigQueryNode, "id" | "kind" | "title">;

export type BigQueryNodePage = {
  nodes: BigQueryNode[];
  /** Present when more nodes follow; passed back as the next call's `cursor`. */
  nextCursor?: string;
  /** Something to tell the user about the whole listing, such as why it is empty. */
  notice?: string;
};

export interface BigQueryConfiguratorRpc {
  /**
   * A location's nodes: the root's (`bigquery`) are the projects this account holds a role in, a
   * project's its datasets and a dataset's its tables, narrowed to those whose names contain `query`
   * when one is given. A query that names a place rather than searching for one (a Cloud Console
   * link, a connection's URL, a `project.dataset.table` reference, or at the root a project ID
   * that is not listed) answers with what it names, if this account can see it. `cursor` is null
   * for the first page, else the `nextCursor` of the page before.
   */
  listNodes(parentId: string, query: string, cursor: string | null): Promise<BigQueryNodePage>;
  /** The node an id names, with where it lives, or null when this account cannot see it. */
  getNode(id: string): Promise<BigQueryNode | null>;
  /** The projects this account holds a role in whose names contain `query`: where its query jobs may run. */
  listProjects(query: string): Promise<ConfiguratorOption[]>;
}
