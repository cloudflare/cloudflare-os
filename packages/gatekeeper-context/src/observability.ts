import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Context gatekeeper. */
export type ContextObservabilityFields = {
  bodyBytes: number;
  branch: string;
  collectionId: string;
  commit: string;
  consecutiveFailures: number;
  filepath: string;
  invalidSkillManifestCount: number;
  invalidSkillManifests: Array<{ filepath: string; reason: string }>;
  maxBodyBytes: number;
  operation: string;
  repoName: string;
  tokenId: number | string;
  vendorId: string;
};

/** Ambient observability fields for one Context gatekeeper operation. */
export const obsContext = createObservabilityContext<ContextObservabilityFields>();
