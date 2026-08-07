// Object/field mapping and text serialization for Salesforce records.
//
// One object_config row drives each object type: which SOQL fields to select, which of those feed
// the embedding text, and which field supplies the display name. The registry below seeds the
// default set for the Touchless org; operators can add object types by inserting object_config rows
// without deploying code.

import type { SfJson, SfRecord, SalesforceVectorMetadata } from "./salesforce-types.js";

// Default configuration for a known object type.
export type ObjectTypeConfig = {
  objectType: string;
  title: string;
  description?: string;
  // SOQL field API names selected from the object.
  soqlFields: string[];
  // The subset of soqlFields included in the embedding text. Id + SystemModstamp are always added.
  embedFields: string[];
  // The field carrying the record's display name ("Name" for most objects).
  displayField?: string;
  // Field names the common metadata extractor should look for (first match wins). Only these
  // become indexed Vectorize metadata, so keep them few and short.
  ownerField?: string;
  campaignField?: string;
  statusField?: string;
  enabled?: boolean;
};

// The default object set. Field names are the canonical Touchless org names (standard + custom).
export const OBJECT_TYPE_CONFIGS: ObjectTypeConfig[] = [
  {
    objectType: "Account",
    title: "Account",
    description: "Account (dealer/group hierarchy) and its key attributes.",
    soqlFields: [
      "Id", "Name", "Type", "BillingCity", "BillingState", "BillingPostalCode", "Phone",
      "Website", "Industry", "AccountNumber", "ParentId", "Parent.Name", "OwnerId",
      "Owner.Name", "Description", "Client_Status__c", "Exclude_From_Outbound__c",
    ],
    embedFields: [
      "Name", "Type", "BillingCity", "BillingState", "BillingPostalCode", "Phone", "Website",
      "Industry", "AccountNumber", "Parent.Name", "Owner.Name", "Description",
      "Client_Status__c", "Exclude_From_Outbound__c",
    ],
    ownerField: "OwnerId",
    statusField: "Client_Status__c",
  },
  {
    objectType: "Contact",
    title: "Contact",
    description: "Contact / person at an account.",
    soqlFields: [
      "Id", "Name", "Title", "Email", "Phone", "AccountId", "Account.Name", "MailingCity",
      "MailingState", "OwnerId", "Owner.Name", "Primary_Prospect__c", "Timezone__c",
      "Date_of_first_outreach__c",
    ],
    embedFields: [
      "Name", "Title", "Email", "Phone", "Account.Name", "MailingCity", "MailingState",
      "Owner.Name", "Primary_Prospect__c", "Timezone__c",
    ],
    ownerField: "OwnerId",
  },
  {
    objectType: "Campaign",
    title: "Campaign",
    description: "Marketing/outbound campaign and its metadata.",
    soqlFields: [
      "Id", "Name", "Status", "Type", "StartDate", "EndDate", "OwnerId", "Owner.Name",
      "NumberOfContacts", "NumberOfLeads", "Description", "Cadence_Enabled__c",
    ],
    embedFields: [
      "Name", "Status", "Type", "StartDate", "EndDate", "Owner.Name", "NumberOfContacts",
      "NumberOfLeads", "Description", "Cadence_Enabled__c",
    ],
    ownerField: "OwnerId",
    statusField: "Status",
  },
  {
    objectType: "CampaignMember",
    title: "Campaign Member",
    description: "Campaign membership / enrollment.",
    soqlFields: [
      "Id", "CampaignId", "Campaign.Name", "ContactId", "Contact.Name", "LeadId", "Status",
      "Campaign_Account__c", "Campaign_Account__r.Name",
    ],
    embedFields: [
      "Campaign.Name", "Contact.Name", "LeadId", "Status", "Campaign_Account__r.Name",
    ],
    campaignField: "CampaignId",
    statusField: "Status",
  },
  {
    objectType: "CampaignMemberStatus",
    title: "Campaign Member Status",
    description: "Campaign cadence step definitions.",
    soqlFields: ["Id", "CampaignId", "Campaign.Name", "Label", "SortOrder", "IsDefault", "HasResponse"],
    embedFields: ["Campaign.Name", "Label", "SortOrder", "IsDefault", "HasResponse"],
    displayField: "Label",
    campaignField: "CampaignId",
  },
  {
    objectType: "Opportunity",
    title: "Opportunity",
    description: "Pipeline opportunity.",
    soqlFields: [
      "Id", "Name", "StageName", "Amount", "CloseDate", "Type", "AccountId", "Account.Name",
      "OwnerId", "Owner.Name", "Win_Reason__c", "Loss_Reason__c", "Recommended_Next_Step__c",
      "Expected_Close_Date__c",
    ],
    embedFields: [
      "Name", "StageName", "Amount", "CloseDate", "Type", "Account.Name", "Owner.Name",
      "Win_Reason__c", "Loss_Reason__c", "Recommended_Next_Step__c",
    ],
    ownerField: "OwnerId",
    statusField: "StageName",
  },
  {
    objectType: "Task",
    title: "Task",
    description: "Task / activity (cadence steps, call tasks, follow-ups).",
    soqlFields: [
      "Id", "Subject", "Status", "Priority", "WhoId", "Who.Name", "WhatId", "What.Name",
      "ActivityDate", "OwnerId", "Owner.Name", "Description", "Disposition__c",
      "Campaign_Account__c", "Campaign_Account__r.Name",
    ],
    embedFields: [
      "Subject", "Status", "Priority", "Who.Name", "What.Name", "ActivityDate", "Owner.Name",
      "Description", "Disposition__c", "Campaign_Account__r.Name",
    ],
    ownerField: "OwnerId",
    statusField: "Status",
  },
  {
    objectType: "Event",
    title: "Event",
    description: "Calendar event / meeting / demo.",
    soqlFields: [
      "Id", "Subject", "WhoId", "Who.Name", "WhatId", "What.Name", "StartDateTime", "EndDateTime",
      "OwnerId", "Owner.Name", "Disposition__c",
    ],
    embedFields: [
      "Subject", "Who.Name", "What.Name", "StartDateTime", "EndDateTime", "Owner.Name",
      "Disposition__c",
    ],
    ownerField: "OwnerId",
    statusField: "Disposition__c",
  },
  {
    objectType: "Lead",
    title: "Lead",
    description: "Outbound lead.",
    soqlFields: [
      "Id", "Name", "Title", "Company", "Status", "Email", "Phone", "OwnerId", "Owner.Name",
      "Industry", "City", "State",
    ],
    embedFields: [
      "Name", "Title", "Company", "Status", "Email", "Phone", "Owner.Name", "Industry", "City",
      "State",
    ],
    ownerField: "OwnerId",
    statusField: "Status",
  },
  {
    objectType: "Campaign_Account__c",
    title: "Campaign Account",
    description: "Campaign attribution/targeting record.",
    soqlFields: [
      "Id", "Name", "Campaign__c", "Campaign__r.Name", "Account__c", "Account__r.Name",
      "Primary_Contact__c", "Primary_Contact__r.Name", "Status__c", "OwnerId", "Owner.Name",
    ],
    embedFields: [
      "Name", "Campaign__r.Name", "Account__r.Name", "Primary_Contact__r.Name", "Status__c",
      "Owner.Name",
    ],
    ownerField: "OwnerId",
    campaignField: "Campaign__c",
    statusField: "Status__c",
  },
  {
    objectType: "Cadence_Step_Snapshot__c",
    title: "Cadence Step Snapshot",
    description: "Cadence step execution snapshot.",
    soqlFields: [
      "Id", "Name", "Campaign__c", "Campaign__r.Name", "Contact__c", "Contact__r.Name",
      "Status__c", "Step_Status_Label__c", "Activity_Count__c", "Last_Activity_Date__c",
    ],
    embedFields: [
      "Name", "Campaign__r.Name", "Contact__r.Name", "Status__c", "Step_Status_Label__c",
      "Activity_Count__c", "Last_Activity_Date__c",
    ],
    campaignField: "Campaign__c",
    statusField: "Status__c",
  },
  {
    objectType: "Outreach_Scorecard_Entry__c",
    title: "Outreach Scorecard Entry",
    description: "Weekly sales outreach scorecard entry.",
    soqlFields: [
      "Id", "Name", "Scorecard_Key__c", "Unit__c", "Metric__c", "Value__c", "Score__c",
      "Data_As_Of__c",
    ],
    embedFields: [
      "Name", "Scorecard_Key__c", "Unit__c", "Metric__c", "Value__c", "Score__c", "Data_As_Of__c",
    ],
  },
];

// Relationship fields (traversal notation, e.g. "Account.Name") resolve against related records
// that Salesforce returns inline. Any field with a "." is left as-is for SOQL.
export function fieldList(config: ObjectTypeConfig): string[] {
  const set = new Set<string>([
    "Id",
    ...config.soqlFields,
    "SystemModstamp",
    ...config.embedFields,
  ]);
  return [...set];
}

// Concise human-readable label for one field value. Relationship traversal ("Owner.Name") becomes
// "Owner Name"; underscored custom/reference field suffixes are stripped; interior runs of
// whitespace collapse.
export function fieldLabel(field: string): string {
  const label = field
    .replace(/__[cr](?=\.|$)/gi, "")
    .replace(/\./g, " ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return label.length === 0 ? field : label.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve a SOQL field path against nested Salesforce JSON.
 * `Owner.Name` reads `record.Owner.Name`; flat dotted keys are accepted as a fallback.
 */
export function resolveFieldValue(record: SfRecord, fieldPath: string): SfJson | undefined {
  if (!fieldPath) return undefined;
  if (Object.prototype.hasOwnProperty.call(record, fieldPath)) {
    return record[fieldPath];
  }
  const parts = fieldPath.split(".");
  let current: SfJson | undefined = record as unknown as SfJson;
  for (const part of parts) {
    if (current === undefined || current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as { [key: string]: SfJson | undefined })[part];
  }
  return current;
}

// Serialize one record into a single searchable text line. `embedFields` from the config pick the
// meaningful fields; everything else is skipped so long custom-field dumps don't bloat the vector.
export function serializeRecord(
  record: SfRecord,
  config: ObjectTypeConfig,
): { name: string; searchText: string } {
  const displayField = config.displayField ?? "Name";
  const nameValue = resolveFieldValue(record, displayField);
  const name = String(nameValue ?? record.Id ?? "");
  const parts: string[] = [];
  for (const field of config.embedFields) {
    const value = resolveFieldValue(record, field);
    if (value === undefined || value === null) continue;
    // Nested relationship objects should not be stringified wholesale.
    if (typeof value === "object") continue;
    const str = String(value);
    if (str.length === 0) continue;
    if (typeof value === "boolean") {
      parts.push(`${fieldLabel(field)}: ${value ? "yes" : "no"}`);
    } else {
      parts.push(`${fieldLabel(field)}: ${str}`);
    }
  }
  return { name, searchText: `${config.objectType}: ${name}. ${parts.join(". ")}`.trim() };
}

// Extract the brief indexed metadata for Vectorize. Each value must fit the metadata index budget
// (<=64 bytes each); long values are truncated.
export function extractMetadata(
  record: SfRecord,
  config: ObjectTypeConfig,
  name: string,
): SalesforceVectorMetadata {
  const pick = (field?: string): string | undefined => {
    if (!field) return undefined;
    const v = resolveFieldValue(record, field);
    if (v === undefined || v === null || typeof v === "object") return undefined;
    return String(v).slice(0, 64);
  };
  return {
    objectType: config.objectType,
    recordName: name.slice(0, 64),
    ownerId: pick(config.ownerField),
    campaignId: pick(config.campaignField),
    status: pick(config.statusField),
  };
}

// A stable content hash used to detect unchanged records and skip re-embedding.
export async function contentHash(searchText: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(searchText));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
