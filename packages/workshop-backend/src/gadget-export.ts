import type { GadgetExportFormat } from "@gadgets/workshop-shared/api";
import type { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { createExportDeadline, limitExportStream } from "./export-limits";

/** Name of the optional Gadget export handler entrypoint. */
export const GADGET_EXPORT_ENTRYPOINT = "ExportHandler";

type GadgetExportCapability<Gadget extends DurableObject = DurableObject> =
  RpcStub<RpcTarget & Pick<Gadget, keyof Gadget>>;

/** Optional Worker entrypoint exported by a Gadget to customize file exports. */
export interface GadgetExportEntrypoint<Gadget extends DurableObject = DurableObject>
    extends WorkerEntrypoint {
  /** Lists all export formats supported by the Gadget. */
  getExportFormats(gadget: GadgetExportCapability<Gadget>): Promise<GadgetExportFormat[]>;

  /** Produces a server-mode export without retaining `gadget` after this call returns. */
  export(gadget: GadgetExportCapability<Gadget>, id: string): Promise<ReadableStream<Uint8Array>>;
}

const MAX_EXPORT_FORMATS = 32;
const MAX_EXPORT_ID_LENGTH = 128;
const MAX_EXPORT_LABEL_LENGTH = 128;
const MAX_CONTENT_TYPE_LENGTH = 255;
const MAX_FILE_EXTENSION_LENGTH = 16;

const BROWSER_CONTENT_TYPES = new Set([
  "text/html",
  "application/pdf",
  "image/png",
  "image/jpeg",
]);

function boundedString(name: string, maxLength: number) {
  return z.string()
    .min(1, `Gadget export format ${name} must be between 1 and ${maxLength} characters.`)
    .max(maxLength,
      `Gadget export format ${name} must be between 1 and ${maxLength} characters.`);
}

const EXPORT_FORMAT_SCHEMA: z.ZodType<GadgetExportFormat> = z.object({
  id: boundedString("id", MAX_EXPORT_ID_LENGTH),
  label: boundedString("label", MAX_EXPORT_LABEL_LENGTH),
  mode: z.enum(["browser", "server"]),
  contentType: boundedString("contentType", MAX_CONTENT_TYPE_LENGTH)
    .regex(/^[-!#$%&'*+.^_`|~0-9A-Za-z]+\/[-!#$%&'*+.^_`|~0-9A-Za-z]+$/,
      "Gadget export format has an invalid content type."),
  fileExtension: boundedString("fileExtension", MAX_FILE_EXTENSION_LENGTH)
    .regex(/^\.[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/,
      "Gadget export format has an invalid file extension."),
}).superRefine((format, context) => {
  if (format.mode === "browser" && !BROWSER_CONTENT_TYPES.has(format.contentType)) {
    context.addIssue({
      code: "custom",
      path: ["contentType"],
      message: `Browser export format ${format.id} has an unsupported content type.`,
    });
  }
});

const EXPORT_FORMATS_SCHEMA = z.array(EXPORT_FORMAT_SCHEMA)
  .max(MAX_EXPORT_FORMATS, `A Gadget may define at most ${MAX_EXPORT_FORMATS} export formats.`)
  .superRefine((formats, context) => {
    const ids = new Set<string>();
    formats.forEach((format, index) => {
      if (ids.has(format.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `Gadget export format id is not unique: ${format.id}`,
        });
      }
      ids.add(format.id);
    });
  });

const DEFAULT_EXPORT_FORMATS: GadgetExportFormat[] = [
  {
    id: "html",
    label: "HTML",
    mode: "browser",
    contentType: "text/html",
    fileExtension: ".html",
  },
  {
    id: "pdf",
    label: "PDF",
    mode: "browser",
    contentType: "application/pdf",
    fileExtension: ".pdf",
  },
];

/** Returns fresh copies of the default HTML and PDF export formats. */
export function defaultExportFormats(): GadgetExportFormat[] {
  return DEFAULT_EXPORT_FORMATS.map(format => ({...format}));
}

/** Validates and normalizes export format metadata returned by Gadget code. */
export function validateExportFormats(value: unknown): GadgetExportFormat[] {
  const result = EXPORT_FORMATS_SCHEMA.safeParse(value);
  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "Invalid Gadget export formats.");
  }
  return result.data;
}

/** Reads custom formats, returning null when the named entrypoint appears to be absent. */
export async function readCustomExportFormats<Gadget>(
  handler: {getExportFormats(gadget: Gadget): Promise<unknown>},
  gadget: Gadget,
): Promise<GadgetExportFormat[] | null> {
  const deadline = createExportDeadline("Listing Gadget export formats timed out.");
  try {
    return validateExportFormats(await deadline.race(handler.getExportFormats(gadget)));
  } catch (error) {
    // TODO: Local dev doesn't match production here. This appears to be a
    // runtime bug. When the entrypoint is missing in local dev, the first error
    // message is returned. In production, "internal error; reference = ..." is
    // returned instead. Until the runtime provides a more descriptive error
    // message, we assume that all internal errors mean that the entrypoint is
    // missing.
    if (error instanceof Error &&
        (error.message === `Worker has no such entrypoint: ${GADGET_EXPORT_ENTRYPOINT}` ||
          error.message.startsWith("internal error"))) {
      return null;
    }
    throw error;
  } finally {
    deadline.clear();
  }
}

/** Applies the platform export limits to a Gadget-generated server stream. */
export async function exportServerFormat(
  createStream: () => Promise<ReadableStream<Uint8Array>>,
): Promise<ReadableStream<Uint8Array>> {
  const deadline = createExportDeadline("Gadget export timed out.");
  const streamPromise = createStream();
  try {
    const source = await deadline.race(streamPromise);
    return limitExportStream(source, deadline);
  } catch (error) {
    deadline.clear();
    void streamPromise.then(stream => stream.cancel(error), () => {}).catch(() => {});
    throw error;
  }
}
