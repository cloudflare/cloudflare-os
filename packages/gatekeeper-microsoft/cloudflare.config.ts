import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, bindings, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

/**
 * No `vars`: every setting has an in-code default. A deployment pins its tenant with
 * `MICROSOFT_TENANT_ID` (default `organizations`, which then requires `MICROSOFT_ALLOWED_TENANT_IDS`),
 * and caps what agents may do with `MICROSOFT_SHAREPOINT_ACCESS` (`write`, the default, or `read`),
 * `MICROSOFT_OUTLOOK_ACCESS` (`send`, the default, `draft` or `read`) and
 * `MICROSOFT_CALENDAR_ACCESS` (`schedule`, the default, `edit` or `read`). `MICROSOFT_SHAREPOINT_SITES`
 * (`all`, the default, or `selected`) chooses whether SharePoint asks for every site the user can
 * open or only the sites a SharePoint admin grants the app.
 */
export default defineGadgetsWorker({
  name: "gatekeeper-microsoft",
  entrypoint: ".wrangler/validate/src/microsoft.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  observability: OBSERVABILITY,
  env: {
    // Workers AI's `toMarkdown()`, which turns PDFs into text. Optional: without it a PDF is
    // described rather than read. It always runs remotely, so `pnpm dev-server` keeps it only with
    // --use-workers-ai-binding.
    AI: bindings.ai(),
  },
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "SharePointGatekeeper", "OutlookGatekeeper", "OutlookHookDriver", "CalendarGatekeeper"] },
];
