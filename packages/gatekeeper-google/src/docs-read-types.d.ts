/** Metadata for one native Google Doc. */
export type DocMetadata = {
  /** Document title. */
  title: string;

  /** When the document was last modified. */
  lastModified: Date;
}

/** Read-only access to one native Google Doc. */
export interface GoogleDocReadSession {
  /** Return current document metadata. */
  getMetadata(): Promise<DocMetadata>;

  /** Return the document body as Markdown. Throws if the document has multiple tabs. */
  getContent(): Promise<string>;
}
