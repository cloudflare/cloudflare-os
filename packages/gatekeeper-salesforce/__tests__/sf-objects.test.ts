import { describe, expect, it } from "vitest";
import {
  OBJECT_TYPE_CONFIGS, extractMetadata, fieldLabel, fieldList, resolveFieldValue, serializeRecord,
} from "../src/sf-objects.js";
import type { SfRecord } from "../src/salesforce-types.js";

const accountConfig = OBJECT_TYPE_CONFIGS.find((c) => c.objectType === "Account")!;

/** Nested relationship shape as returned by Salesforce REST /query. */
const sampleAccount: SfRecord = {
  Id: "001cv000016kMOHAA2",
  Name: "Fred Anderson Toyota",
  Type: "Customer",
  BillingCity: "Raleigh",
  BillingState: "NC",
  BillingPostalCode: "27601",
  Website: "fredanderson.com",
  ParentId: "001cv000016kPARENT",
  Parent: { Name: "Fred Anderson Group" },
  OwnerId: "005cv00000AUAXFAA5",
  Owner: { Name: "Matt Filion" },
  Description: null,
  Client_Status__c: "Active",
  Exclude_From_Outbound__c: false,
  SystemModstamp: "2026-08-01T10:00:00.000Z",
};

describe("Salesforce object config", () => {
  it("includes Id, SystemModstamp, soql fields and embed fields in the field list", () => {
    const fields = fieldList(accountConfig);
    for (const f of ["Id", "SystemModstamp", "Name", "BillingState", "Owner.Name"]) {
      expect(fields).toContain(f);
    }
    // No duplicates.
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("exposes the default object set", () => {
    const types = OBJECT_TYPE_CONFIGS.map((c) => c.objectType);
    expect(types).toContain("Account");
    expect(types).toContain("Contact");
    expect(types).toContain("Campaign");
    expect(types).toContain("Opportunity");
    expect(types).toContain("Task");
    expect(types).toContain("Event");
    expect(types).toContain("Lead");
  });
});

describe("resolveFieldValue", () => {
  it("resolves nested relationship paths from Salesforce JSON", () => {
    expect(resolveFieldValue(sampleAccount, "Owner.Name")).toBe("Matt Filion");
    expect(resolveFieldValue(sampleAccount, "Parent.Name")).toBe("Fred Anderson Group");
    expect(resolveFieldValue(sampleAccount, "Name")).toBe("Fred Anderson Toyota");
  });

  it("falls back to flat dotted keys when present", () => {
    const flat: SfRecord = {
      Id: "x",
      "Owner.Name": "Flat Owner",
    };
    expect(resolveFieldValue(flat, "Owner.Name")).toBe("Flat Owner");
  });

  it("returns undefined for missing nested paths", () => {
    expect(resolveFieldValue({ Id: "x" }, "Owner.Name")).toBeUndefined();
    expect(resolveFieldValue(sampleAccount, "Account.Name")).toBeUndefined();
  });
});

describe("serializeRecord", () => {
  it("builds a searchable text with nested relationship fields", () => {
    const { name, searchText } = serializeRecord(sampleAccount, accountConfig);
    expect(name).toBe("Fred Anderson Toyota");
    expect(searchText).toContain("Account: Fred Anderson Toyota");
    expect(searchText).toContain("Type: Customer");
    expect(searchText).toContain("BillingState: NC");
    expect(searchText).toContain("Owner Name: Matt Filion");
    expect(searchText).toContain("Parent Name: Fred Anderson Group");
    expect(searchText).toContain("Exclude From Outbound: no");
  });

  it("serializes Campaign__r.Name from nested custom relationship JSON", () => {
    const campaignAccount = OBJECT_TYPE_CONFIGS.find((c) => c.objectType === "Campaign_Account__c")!;
    const record: SfRecord = {
      Id: "a0Xcv0000000001",
      Name: "CA-001",
      Campaign__c: "701WJ00000sjUR8YAM",
      Campaign__r: { Name: "Toyota ETS Cadence" },
      Account__r: { Name: "Fred Anderson Toyota" },
      Primary_Contact__r: { Name: "Jane Doe" },
      Status__c: "Active",
      Owner: { Name: "Matt Filion" },
      SystemModstamp: "2026-08-01T10:00:00.000Z",
    };
    const { searchText } = serializeRecord(record, campaignAccount);
    expect(searchText).toContain("Campaign Name: Toyota ETS Cadence");
    expect(searchText).toContain("Account Name: Fred Anderson Toyota");
    expect(searchText).toContain("Primary Contact Name: Jane Doe");
  });

  it("skips null/empty values", () => {
    const record: SfRecord = { Id: "x", Name: "Acme", Description: "" };
    const { searchText } = serializeRecord(record, accountConfig);
    expect(searchText).not.toContain("Description");
  });
});

describe("extractMetadata", () => {
  it("pulls owner, status and campaign from configured fields", () => {
    const meta = extractMetadata(sampleAccount, accountConfig, "Fred Anderson Toyota");
    expect(meta).toEqual({
      objectType: "Account",
      recordName: "Fred Anderson Toyota",
      ownerId: "005cv00000AUAXFAA5",
      campaignId: undefined,
      status: "Active",
    });
  });

  it("truncates long values to the Vectorize metadata budget", () => {
    const long = "x".repeat(200);
    const meta = extractMetadata(
      { Id: "1", Name: long, Client_Status__c: "ok" } as SfRecord,
      accountConfig,
      long,
    );
    expect(meta.recordName.length).toBe(64);
  });
});

describe("fieldLabel", () => {
  it("humanizes custom and relationship field names", () => {
    expect(fieldLabel("Client_Status__c")).toBe("Client Status");
    expect(fieldLabel("Owner.Name")).toBe("Owner Name");
    expect(fieldLabel("Campaign__r.Name")).toBe("Campaign Name");
    expect(fieldLabel("BillingState")).toBe("BillingState");
  });
});
