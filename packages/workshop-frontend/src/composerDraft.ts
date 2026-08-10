import { isOutputIcon, type MessageFormatRef, type OutputIcon } from "@gadgets/workshop-shared/api";

const COMPOSER_DRAFT_PREFIX = "gadgets:composer-draft:v1";

export type ComposerDraftCapsule = {
  start: number;
  length: number;
  url: string;
};

export type ComposerDraftFormat = {
  start: number;
  length: number;
  noun: string;
  icon: OutputIcon;
};

export type StoredComposerDraft = {
  version: 1;
  text: string;
  formats: MessageFormatRef[];
};

export type RestoredComposerDraft = {
  text: string;
  formats: Array<ComposerDraftFormat & { logo?: string }>;
};

export function composerDraftStorageKey(userId: string, scope: string): string {
  return `${COMPOSER_DRAFT_PREFIX}:${userId}:${scope}`;
}

export function serializeComposerDraft(
  text: string,
  capsules: readonly ComposerDraftCapsule[],
  formats: readonly ComposerDraftFormat[],
): StoredComposerDraft {
  const tokens = [
    ...capsules.map((capsule) => ({ ...capsule, kind: "capsule" as const })),
    ...formats.map((format) => ({ ...format, kind: "format" as const })),
  ].toSorted((a, b) => a.start - b.start);

  let normalized = "";
  let cursor = 0;
  const storedFormats: MessageFormatRef[] = [];
  for (const token of tokens) {
    if (token.start < cursor || token.start < 0 || token.length < 0 ||
        token.start + token.length > text.length) {
      continue;
    }
    normalized += text.slice(cursor, token.start);
    const replacement = token.kind === "capsule" ? token.url : token.noun;
    if (token.kind === "format") {
      storedFormats.push({
        position: normalized.length,
        length: replacement.length,
        noun: token.noun,
        icon: token.icon,
      });
    }
    normalized += replacement;
    cursor = token.start + token.length;
  }
  normalized += text.slice(cursor);

  return { version: 1, text: normalized, formats: storedFormats };
}

export function decorateComposerDraft(
  draft: StoredComposerDraft,
  logos: readonly (string | undefined)[],
  logoSlot: string,
): RestoredComposerDraft {
  let text = "";
  let cursor = 0;
  const formats: RestoredComposerDraft["formats"] = [];
  for (const [index, format] of draft.formats.entries()) {
    text += draft.text.slice(cursor, format.position);
    const logo = logos[index];
    const prefix = logo ? logoSlot : "";
    const start = text.length;
    text += prefix + format.noun;
    formats.push({
      start,
      length: prefix.length + format.length,
      noun: format.noun,
      icon: format.icon,
      ...(logo ? { logo } : {}),
    });
    cursor = format.position + format.length;
  }
  text += draft.text.slice(cursor);
  return { text, formats };
}

export function readComposerDraft(key: string | undefined): StoredComposerDraft | undefined {
  if (!key) return undefined;
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || typeof record.text !== "string" ||
        !Array.isArray(record.formats)) {
      return undefined;
    }

    const formats: MessageFormatRef[] = [];
    let previousEnd = 0;
    for (const candidate of record.formats) {
      if (!candidate || typeof candidate !== "object") return undefined;
      const format = candidate as Record<string, unknown>;
      if (!Number.isInteger(format.position) || !Number.isInteger(format.length) ||
          typeof format.noun !== "string" || !isOutputIcon(format.icon)) {
        return undefined;
      }
      const position = format.position as number;
      const length = format.length as number;
      if (position < previousEnd || format.noun.length === 0 || length !== format.noun.length ||
          record.text.slice(position, position + length) !== format.noun) {
        return undefined;
      }
      formats.push({ position, length, noun: format.noun, icon: format.icon });
      previousEnd = position + length;
    }
    return { version: 1, text: record.text, formats };
  } catch {
    return undefined;
  }
}

export function writeComposerDraft(
  key: string | undefined,
  draft: StoredComposerDraft | undefined,
): void {
  if (!key) return;
  try {
    if (draft?.text) {
      window.sessionStorage.setItem(key, JSON.stringify(draft));
    } else {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Storage can be unavailable in restricted browser contexts. Draft recovery is best-effort.
  }
}
