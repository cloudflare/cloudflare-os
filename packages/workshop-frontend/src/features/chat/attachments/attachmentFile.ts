/**
 * What the cards and the viewer need to know of a file, whether it is attached to a sent message
 * or still waiting in the composer.
 */
export type AttachmentFile = {
  id: string;
  name?: string;
  mimeType: string;
  size: number;
};

/** Fetches the bytes of the attachment with this id. */
export type AttachmentContentLoader = (id: string) => Promise<Uint8Array>;

/** A set of attachments' bytes, each file read once and shared (useAttachmentContents). */
export type AttachmentContents = {
  /** Reads a file, or shares the read under way, and keeps it while the set is shown. */
  content: AttachmentContentLoader;
  /** Reads a file as `content` does, but keeps it only while something holds it. */
  read: AttachmentContentLoader;
  /**
   * Holds a file's read, under way or yet to start, until the returned function is called. A read
   * nothing holds or keeps is then stopped, if it is still under way, and forgotten, bytes and all.
   */
  hold: (id: string) => () => void;
  /** Forgets the reads that failed, so the next to ask reads again. */
  forgetFailures: () => void;
};
