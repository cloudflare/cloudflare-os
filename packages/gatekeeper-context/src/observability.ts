import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Context gatekeeper. */
export type ContextObservabilityFields = {
  bodyBytes: number;
  branch: string;
  collectionId: string;
  dir: string;
  filepath: string;
  maxBodyBytes: number;
  maxGitDirBytes: number;
  operation: string;
  repoName: string;
  sizeBytes: number;
  tokenId: number | string;
  vendorId: string;
};

/** Ambient observability fields for one Context gatekeeper operation. */
export const obsContext = createObservabilityContext<ContextObservabilityFields>();
