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

  /** Return the document body converted to Markdown. */
  getContent(): Promise<string>;
}
