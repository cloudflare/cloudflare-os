import type { ConfiguratorOption } from "./configurator-option";
export type { ConfiguratorOption };

export type GoogleSheetsConfiguratorValues = {
  spreadsheetId?: string | null;
}

export interface GoogleSheetsConfiguratorRpc {
  listSpreadsheets(query: string): Promise<ConfiguratorOption[]>;
}
