import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { isTextLikeAttachmentMimeType } from "@gadgets/workshop-shared/api";
import { PDF_MIME_TYPE, modelApiSupportsPdfAttachments } from "./chat-attachment-pdf";

// Converts a stored chat attachment into the content parts that represent it in the user message
// sent to the model. This runs during history replay (agent.ts), which rebuilds the full message
// history for every request -- so an attachment the current model can't accept (e.g. an image
// after the chat switched to a text-only model) must be replaced with a text marker, not sent:
// the provider would fail the request with a 400, and since every subsequent request replays the
// same history, that single attachment would break the chat permanently.

/**
 * Convert one chat attachment into the content parts to splice into its user message, degrading
 * anything `model` cannot accept to a text marker. `data` is the attachment's stored bytes.
 */
export function chatAttachmentModelParts(
  attachment: { mimeType: string; name?: string },
  data: Uint8Array,
  model: Model<Api>,
): (TextContent | ImageContent)[] {
  let filename = attachment.name ? ` (${attachment.name})` : "";
  let modelAcceptsImages = model.input.includes("image");
  if (attachment.mimeType.startsWith("image/") && modelAcceptsImages) {
    return [{
      type: "image",
      data: data.toBase64(),
      mimeType: attachment.mimeType,
    }];
  } else if (isTextLikeAttachmentMimeType(attachment.mimeType)) {
    return [{
      type: "text",
      text: `\n\n[Attached text file${filename}]\n${new TextDecoder().decode(data)}`,
    }];
  } else if (attachment.mimeType === PDF_MIME_TYPE &&
             modelApiSupportsPdfAttachments(model.api) && modelAcceptsImages) {
    // pi has no file/document content part, so a PDF rides an ImageContent part (hence the
    // image modality check above); the model handle rewrites it into the provider's native
    // document block just before the request goes out (see chat-attachment-pdf.ts). The text
    // part carries the filename, which the disguised part cannot.
    return [
      {type: "text", text: `\n\n[Attached PDF file${filename}]`},
      {type: "image", data: data.toBase64(), mimeType: attachment.mimeType},
    ];
  } else {
    // Attachment types the current model can't take -- an image or PDF on a text-only model,
    // or types some providers accepted before the pi migration -- degrade to a text marker
    // rather than failing the whole replay.
    return [{
      type: "text",
      text: `\n\n[Attached file${filename} (${attachment.mimeType}) omitted — ` +
          `this file type is not supported by the current model]`,
    }];
  }
}
