// Salesforce gatekeeper worker entrypoint. Exports the durable sync workflow class and the
// capnweb-validate gatekeeper classes; the worker itself is reached over RPC/Workflows, not HTTP.

export { SalesforceSyncWorkflow } from "./sync-workflow.js";
export { SalesforceGatekeeper } from "./salesforce-gatekeeper.js";
export {
  GatekeeperVendor, SalesforceAccount, SalesforceVerifier,
} from "./salesforce-gatekeeper.js";

// Keep ES Module worker format; this worker is used over RPC/Workflows, not HTTP.
export default {
  async fetch(): Promise<Response> {
    return new Response("Salesforce gatekeeper worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
