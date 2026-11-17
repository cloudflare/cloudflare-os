/**
 * The model the user's messages are answered by: the one they chose as their default, while it is
 * still one of the models offered to them, and otherwise the first of those. A preference for a
 * model that is no longer offered is kept by the server, so it holds again if the model comes back.
 */
export const defaultModelOf = <Model extends { id: string }>(models: readonly Model[], preferred: string | null): Model | undefined =>
  models.find(({ id }) => id === preferred) ?? models[0]
