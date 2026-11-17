/**
 * The stars (outputs' keys, in their order) with `key` starred or not: one newly starred comes
 * first, as the latest starred does, and the others keep their places.
 */
export const withStar = (stars: string[], key: string, on: boolean): string[] => {
  const others = stars.filter((other) => other !== key)
  return on ? [key, ...others] : others
}

/**
 * The stars with those listed put in another `order`. A star for what is not listed stays, after
 * them: its output may only not have been read yet, as while the library's index catches up.
 */
export const withStarOrder = (stars: string[], order: string[]): string[] => [...order, ...stars.filter((key) => !order.includes(key))]
