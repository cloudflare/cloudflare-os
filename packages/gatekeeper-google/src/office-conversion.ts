// Office files (.xlsx, .docx, .pptx and kin) in Drive, which Google's Sheets, Docs and Slides APIs
// cannot edit in place, and the native copy a connect dialog makes of one instead.

import type { AccessTokenProvider } from "./auth-retry";
import {
  conversionError, CONVERTED_FROM_PROPERTY, DriveApi, DriveApiRequestError, isDriveFileId,
  isInsufficientScope,
  type DriveConversionSource, type DriveCopyLocation,
} from "./drive-api";
import { GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, GOOGLE_SLIDES_MIME_TYPE } from "./drive-session";
import { GoogleApiError } from "./google-response";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({ component: "gatekeeper.google.office", vendorId: "google" });

/** The native resource kinds an Office file can be converted into. */
export type OfficeKind = "sheets" | "doc" | "slides";

/** Per kind: its native MIME type, the Office MIME types Drive converts into it, and its name. */
export const OFFICE_KINDS: Record<OfficeKind, {
  nativeMimeType: string;
  /** Office MIME type to the extension it is shown as; compared case-insensitively. */
  officeMimeTypes: Record<string, string>;
  resourceTitle: "Sheets" | "Docs" | "Slides";
}> = {
  sheets: {
    nativeMimeType: GOOGLE_SHEET_MIME_TYPE,
    officeMimeTypes: {
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
      "application/vnd.ms-excel": "xls",
      "application/vnd.ms-excel.sheet.macroEnabled.12": "xlsm",
      "application/vnd.oasis.opendocument.spreadsheet": "ods",
      "application/x-vnd.oasis.opendocument.spreadsheet": "ods",
    },
    resourceTitle: "Sheets",
  },
  doc: {
    nativeMimeType: GOOGLE_DOC_MIME_TYPE,
    officeMimeTypes: {
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
      "application/msword": "doc",
      "application/vnd.oasis.opendocument.text": "odt",
      "application/x-vnd.oasis.opendocument.text": "odt",
      "application/rtf": "rtf",
      "text/rtf": "rtf",
    },
    resourceTitle: "Docs",
  },
  slides: {
    nativeMimeType: GOOGLE_SLIDES_MIME_TYPE,
    officeMimeTypes: {
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
      "application/vnd.ms-powerpoint": "ppt",
      "application/vnd.oasis.opendocument.presentation": "odp",
      "application/x-vnd.oasis.opendocument.presentation": "odp",
    },
    resourceTitle: "Slides",
  },
};

/**
 * The extension `mimeType` is shown as when it is an Office type `kind` converts, such as "xlsx";
 * otherwise `undefined`. Drive and its import list disagree on case ("macroEnabled").
 */
export function officeLabel(kind: OfficeKind, mimeType: string | undefined): string | undefined {
  if (mimeType === undefined) return undefined;
  let lower = mimeType.toLowerCase();
  return Object.entries(OFFICE_KINDS[kind].officeMimeTypes)
    .find(([type]) => type.toLowerCase() === lower)?.[1];
}

/** The kind a file of `mimeType` connects as for editing: its own native kind, or the one it converts into. */
export function editorKind(mimeType: string | undefined): OfficeKind | undefined {
  return (Object.keys(OFFICE_KINDS) as OfficeKind[]).find(kind =>
    OFFICE_KINDS[kind].nativeMimeType === mimeType || officeLabel(kind, mimeType) !== undefined);
}

/** `name` without a trailing Office extension of `kind`, as the copy is named. */
export function nativeCopyName(kind: OfficeKind, name: string): string {
  let lower = name.toLowerCase();
  for (let label of new Set(Object.values(OFFICE_KINDS[kind].officeMimeTypes))) {
    let suffix = `.${label}`;
    if (lower.endsWith(suffix) && name.length > suffix.length) return name.slice(0, -suffix.length);
  }
  return name;
}

/** The refusal for an Office file bound or opened as `kind`, saying how to connect it instead. */
export function officeFileError(kind: OfficeKind): Error {
  let { resourceTitle, officeMimeTypes } = OFFICE_KINDS[kind];
  let example = Object.values(officeMimeTypes)[0];
  let verb = kind === "doc" ? "edit" : "open";
  return new Error(
    `Google ${resourceTitle} cannot ${verb} this file: it is an Office file, such as .${example}, ` +
    `rather than a Google ${resourceTitle} file, and Google's API cannot ${verb} it. Connect it ` +
    `again through the connect dialog, which offers to make a Google ${resourceTitle} copy.`);
}

/**
 * The refusal for a file of another type, such as a .csv, bound or opened as `kind`: the connect
 * dialog cannot convert it, so it says how to make a copy in Google's own editor.
 */
export function nonNativeFileError(kind: OfficeKind): Error {
  let { resourceTitle } = OFFICE_KINDS[kind];
  let verb = kind === "doc" ? "edit" : "open";
  return new Error(
    `Google ${resourceTitle} cannot ${verb} this file because it is not a Google ${resourceTitle} ` +
    `file. Open it in Google ${resourceTitle}, choose File > Save as Google ${resourceTitle}, and ` +
    "connect the copy instead.");
}

/**
 * Google's refusal of a native request explained, when the refusal is `FAILED_PRECONDITION` and
 * Drive confirms the file is not of `kind`'s native type: as {@link officeFileError} for an Office
 * type the connect dialog converts, otherwise as {@link nonNativeFileError}. Otherwise `error`
 * itself, also when Drive cannot say. The status alone does not say why.
 */
export async function explainUnopenedFile(
  kind: OfficeKind, error: unknown, mimeType: () => Promise<string | undefined>,
): Promise<unknown> {
  if (!(error instanceof GoogleApiError) || error.providerStatus !== "FAILED_PRECONDITION") {
    return error;
  }
  let type = await mimeType().catch(() => undefined);
  if (type === undefined || type === OFFICE_KINDS[kind].nativeMimeType) return error;
  return officeLabel(kind, type) === undefined ? nonNativeFileError(kind) : officeFileError(kind);
}

/** What {@link OfficeConversion.inspectFile} found. */
export type OfficeFileInspection =
  | { type: "native" }
  | {
      type: "office";
      canCopy: boolean;
      /** A copy this deployment already made of the file, when one is found. */
      existingCopy?: { fileId: string; title: string; convertedAt: Date };
    }
  | { type: "unsupported" }
  /** A file that must not be connected as it is, nor converted, and why, in our own words. */
  | { type: "refused"; message: string };

/** What {@link OfficeConversion.convertFile} did. */
export type OfficeConversionResult =
  | { type: "needsAccess" }
  | { type: "converted"; fileId: string; title: string; location: DriveCopyLocation; reused: boolean };

/**
 * Converts Drive Office files into native files of one kind, for the Drive picker.
 *
 * Constructed with the kind, a token provider for the configurator's account, and `hasAccess`,
 * which reports whether the account holds the Office import grant. `hasAccess` is asked afresh
 * before every copy, since the grant can arrive while the dialog is open. Everything the
 * configurator frame sends is checked again here before anything is written.
 */
export class OfficeConversion {
  #kind: OfficeKind;
  #drive: DriveApi;
  #hasAccess: () => Promise<boolean>;

  constructor(kind: OfficeKind, getToken: AccessTokenProvider, hasAccess: () => Promise<boolean>) {
    this.#kind = kind;
    this.#drive = new DriveApi(getToken);
    this.#hasAccess = hasAccess;
  }

  /**
   * Whether `fileId` is native, an Office file this kind converts (with any earlier copy), neither,
   * or refused outright. Throws only when Drive cannot say.
   */
  async inspectFile(fileId: string): Promise<OfficeFileInspection> {
    if (!isDriveFileId(fileId)) return { type: "refused", message: NOT_A_FILE_ID };
    let source = await this.#drive.getConversionSource(fileId);
    if (source.mimeType === OFFICE_KINDS[this.#kind].nativeMimeType) return { type: "native" };
    if (officeLabel(this.#kind, source.mimeType) === undefined) return { type: "unsupported" };
    if (source.trashed === true) return { type: "refused", message: TRASHED };
    let existingCopy = await this.#findCopy(fileId);
    return {
      type: "office",
      canCopy: source.canCopy === true,
      ...(existingCopy ? { existingCopy } : {}),
    };
  }

  /**
   * Makes a native copy of Office file `fileId`, or with `reuse` returns that earlier copy of it
   * once it is confirmed to be one. `needsAccess` when a copy is to be made and the account does
   * not hold the grant; reusing a copy reads only metadata, which the connection already sees.
   */
  async convertFile(fileId: string, opts: { reuse?: string } = {}): Promise<OfficeConversionResult> {
    requireFileId(fileId);
    let { reuse } = opts;
    if (reuse !== undefined) requireFileId(reuse);
    else if (!(await this.#hasAccess())) return { type: "needsAccess" };
    let method = reuse === undefined ? "copy" : "reuse";
    try {
      let source = this.#checkSource(await this.#drive.getConversionSource(fileId), reuse === undefined);
      if (reuse !== undefined) return await this.#reuse(source, reuse);
      let { copy, location } = await this.#drive.makeNativeCopy(
        source, nativeCopyName(this.#kind, source.name), OFFICE_KINDS[this.#kind].nativeMimeType);
      logger.info("converted an Office file into a native copy", {
        event: "google.office.converted", conversionKind: this.#kind, fileId, copyFileId: copy.id,
      });
      return { type: "converted", fileId: copy.id, title: copy.name, location, reused: false };
    } catch (error) {
      if (reuse === undefined && isInsufficientScope(error)) return { type: "needsAccess" };
      let explained = conversionError(error);
      logger.warn("failed to convert an Office file", {
        event: "google.office.failed", conversionKind: this.#kind, fileId, method,
        ...(error instanceof DriveApiRequestError ? {
          httpStatus: error.status, ...(error.reason ? { providerReasons: [error.reason] } : {}),
        } : {}),
        error: explained,
      });
      throw explained;
    }
  }

  /**
   * Refuses a source this kind cannot convert, in our own words. Only a new copy needs the owner
   * to allow copying; a copy made before stays the account's to use.
   */
  #checkSource(source: DriveConversionSource, copying: boolean): DriveConversionSource {
    let { resourceTitle } = OFFICE_KINDS[this.#kind];
    if (officeLabel(this.#kind, source.mimeType) === undefined) {
      throw new Error(`This file is not an Office file Google ${resourceTitle} can convert.`);
    }
    if (source.trashed !== false) throw new Error(TRASHED);
    if (copying && source.canCopy !== true) {
      throw new Error("The owner of this file has turned off copying, so it cannot be converted.");
    }
    return source;
  }

  /** `copyId` once Drive confirms it is a live copy of `source` the account can edit. */
  async #reuse(source: DriveConversionSource, copyId: string): Promise<OfficeConversionResult> {
    let copy = await this.#drive.getConvertedCopy(copyId);
    if (copy.appProperties?.[CONVERTED_FROM_PROPERTY] !== source.id ||
        copy.mimeType !== OFFICE_KINDS[this.#kind].nativeMimeType || copy.trashed !== false ||
        copy.canEdit !== true) {
      throw new Error("That copy is no longer available.");
    }
    let parent = source.parents?.[0];
    let location: DriveCopyLocation =
      parent !== undefined && copy.parents?.includes(parent) ? "besideOriginal" : "myDrive";
    logger.info("reused a native copy of an Office file", {
      event: "google.office.reused", conversionKind: this.#kind, fileId: source.id,
      copyFileId: copy.id,
    });
    return { type: "converted", fileId: copy.id, title: copy.name, location, reused: true };
  }

  /** The newest copy already made of `fileId`. Best effort: a lookup that fails finds none. */
  async #findCopy(fileId: string)
      : Promise<{ fileId: string; title: string; convertedAt: Date } | undefined> {
    let copies = await this.#drive.findConvertedCopies(
      fileId, OFFICE_KINDS[this.#kind].nativeMimeType).catch(() => []);
    for (let copy of copies) {
      let convertedAt = new Date(copy.createdTime ?? NaN);
      if (!Number.isNaN(convertedAt.valueOf())) return { fileId: copy.id, title: copy.name, convertedAt };
    }
    return undefined;
  }
}

const NOT_A_FILE_ID = "Not a Google Drive file ID.";
const TRASHED = "This file is in the Drive trash. Restore it before converting it.";

function requireFileId(fileId: string): void {
  if (!isDriveFileId(fileId)) throw new Error(NOT_A_FILE_ID);
}
