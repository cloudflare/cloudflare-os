// The producers the risk-review gate reads, named once: for the scripts that write their
// artifacts, and for the gate, which accepts an artifact only from a run of the workflow file
// named here.

/** A full commit SHA. */
export const SHA = /^[0-9a-f]{40}$/;

/** The login of the one bot whose pull requests a proof can take. */
export const DEPENDABOT_LOGIN = "dependabot[bot]";

/** Where the gate looks for a producer's runs. */
export interface Producer {
  /** A reviewer's verdict, or a proof that holds or does not. */
  kind: "verdict" | "proof";
  /** The workflow file whose runs may publish it. */
  workflow: string;
}

/** Proofs that run no pull request code, so nothing in the head can write their artifacts. */
const BASE_PROOFS = ".github/workflows/automerge-proofs.yml";
/** Proofs that build or run the head; their artifacts rest on a maintainer author. */
const HEAD_PROOFS = ".github/workflows/automerge-head-proofs.yml";

/** Every producer, by name. Its artifact is {@link artifactName}. */
export const PRODUCERS = {
  bonk: { kind: "verdict", workflow: ".github/workflows/bonk-pr.yml" },
  opus: { kind: "verdict", workflow: ".github/workflows/review-verdict.yml" },
  "proof-deps": { kind: "proof", workflow: BASE_PROOFS },
  "proof-equivalence": { kind: "proof", workflow: HEAD_PROOFS },
  "proof-tests": { kind: "proof", workflow: HEAD_PROOFS },
  "preview-smoke": { kind: "proof", workflow: HEAD_PROOFS },
} as const satisfies Record<string, Producer>;

/** A producer's name. */
export type ProducerName = keyof typeof PRODUCERS;

/** Narrows a string to a producer's name. */
export function isProducerName(name: string): name is ProducerName {
  return Object.hasOwn(PRODUCERS, name);
}

/** The artifact a producer uploads, which holds one file of the same name plus `.json`. */
export function artifactName(name: ProducerName): string {
  return PRODUCERS[name].kind === "verdict" ? `automerge-verdict-${name}` : `automerge-${name}`;
}
