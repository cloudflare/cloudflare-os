import { describe, expect, it } from "vitest";
import { SharePointListImpl, SharePointListReaderImpl, SharePointReaderImpl, SharePointSessionImpl } from "../src/sharepoint-session";

describe("the SharePoint RPC surface", () => {
  it("keeps the helpers the sessions share off their prototypes, which Cap'n Web exposes whole", () => {
    const helpers = ["resolved", "baseFor", "item", "entry", "overlay", "fileVersion", "listTarget", "columns"];
    for (const cls of [SharePointReaderImpl, SharePointSessionImpl, SharePointListReaderImpl, SharePointListImpl]) {
      expect(Object.getOwnPropertyNames(cls.prototype).filter(name => helpers.includes(name))).toEqual([]);
    }
  });
});
