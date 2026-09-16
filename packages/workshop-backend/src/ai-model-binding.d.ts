/** Simple binding to an AI language model. */
export interface LanguageModelBinding {
  /** Run the model with the given prompt, returning the text it generated. */
  run(options: {prompt: string, systemPrompt?: string}): Promise<string>;
}
