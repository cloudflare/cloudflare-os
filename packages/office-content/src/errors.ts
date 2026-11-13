/** The broad reason a document could not be converted, for the caller to report or fall back on. */
export type ConversionFailureReason =
  /** The bytes are not a well-formed document of the type its name claims. */
  | "corrupt"
  /** Password-protected or rights-managed; there is no text to reach without the key. */
  | "encrypted"
  /** Inflating or parsing it would exceed a resource limit. */
  | "too-large"
  /** Well-formed, but uses a container feature the converter does not implement. */
  | "unsupported";

/** A document of a supported type that could not be converted. The message is safe to show the agent. */
export class DocumentConversionError extends Error {
  override readonly name = "DocumentConversionError";
  constructor(readonly reason: ConversionFailureReason, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
