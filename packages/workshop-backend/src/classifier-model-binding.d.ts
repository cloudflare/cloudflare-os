/**
 * Binding to an AI classifier (decision) model. Rather than writing text, it answers typed
 * questions about a state, with a probability for each allowed answer.
 */
export interface ClassifierModelBinding {
  /**
   * Answer every question about the state. The result holds one answer per question, under the
   * question's key. Throws if the model request fails.
   */
  classify(request: ClassifierRequest): Promise<Record<string, ClassifierAnswer>>;
}

export type ClassifierRequest = {
  /**
   * A JSON object describing what the questions are about, such as a record or application
   * state. Wrap plain text, e.g. `{message: text}`.
   */
  state: JsonObject;

  /** The questions, keyed by ids made of letters, digits, `_`, `.` and `-`. */
  questions: Record<string, ClassifierQuestion>;
};

export type ClassifierQuestion =
  /** Pick one key of `criteria`; each value says when its key applies. */
  | {type: "choice", instructions: string, criteria: Record<string, string>}
  /** Rate on the ordered scale `criteria`, lowest level first. */
  | {type: "score", instructions: string, criteria: string[]}
  /** A yes/no question; `criteria` describes each outcome. */
  | {type: "bool", instructions: string, criteria: {true: string, false: string}};

export type ClassifierAnswer =
  /** The likeliest key of `criteria`, with every key's probability. */
  | {type: "choice", choice: string, probabilities: Record<string, number>, confidence: number}
  /** The probability-weighted level, where 0 is the first level of `criteria`. */
  | {type: "score", score: number, confidence: number}
  /** The probability that the answer is true. */
  | {type: "bool", probability: number};

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = {[key: string]: JsonValue};
