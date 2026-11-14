/**
 * Binding to an AI decision model. Rather than writing text, it answers typed questions about a
 * state, with a probability for each allowed answer.
 */
export interface DecisionModelBinding {
  /**
   * Answer every question about the state. The result holds one answer per question, under the
   * question's key. Throws if the model request fails.
   */
  decide(request: DecisionRequest): Promise<Record<string, DecisionAnswer>>;
}

export type DecisionRequest = {
  /**
   * What the questions are about, such as a record or application state. Must be JSON-compatible.
   */
  state: any;

  /** The questions, keyed by ids made of letters, digits, `_`, `.` and `-`. */
  questions: Record<string, DecisionQuestion>;
};

export type DecisionQuestion =
  /** Pick one key of `criteria`; each value says when its key applies. */
  | {type: "choice", instructions: string, criteria: Record<string, string>}
  /** Rate on the ordered scale `criteria`, lowest level first. */
  | {type: "score", instructions: string, criteria: string[]}
  /** A yes/no question; `criteria` describes each outcome. */
  | {type: "bool", instructions: string, criteria: {true: string, false: string}};

export type DecisionAnswer =
  /** The likeliest key of `criteria`, with every key's probability. */
  | {type: "choice", choice: string, probabilities: Record<string, number>, confidence: number}
  /** The probability-weighted level, where 0 is the first level of `criteria`. */
  | {type: "score", score: number, confidence: number}
  /** The probability that the answer is true. */
  | {type: "bool", probability: number};
