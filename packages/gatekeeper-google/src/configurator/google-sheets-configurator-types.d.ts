import type { ConfiguratorOption } from "./configurator-option";
import type { OfficeConversionResult, OfficeFileInspection } from "../office-conversion";
export type { ConfiguratorOption };

export type GoogleSheetsConfiguratorValues = {
  spreadsheetId?: string | null;
}

export interface GoogleSheetsConfiguratorRpc {
  listSpreadsheets(query: string): Promise<ConfiguratorOption[]>;
  /** Whether `fileId` is native, an Office file this kind converts, or neither. */
  inspectFile(fileId: string): Promise<OfficeFileInspection>;
  /** Whether the account holds the grant `convertFile` needs; asked again after a consent pop-up. */
  hasConversionAccess(): Promise<boolean>;
  /** Makes a native copy of Office file `fileId`, or confirms and returns the copy `reuse` names. */
  convertFile(fileId: string, opts?: { reuse?: string }): Promise<OfficeConversionResult>;
}
