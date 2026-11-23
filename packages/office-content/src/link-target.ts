/**
 * The longest link target the readers keep, far past any address someone writes. A link is named
 * once and carried by every run or cell it covers, and each of those carries its own copy once the
 * model leaves the reader, so a long one would be paid for many times over.
 */
export const MAX_LINK_TARGET = 8_192;
