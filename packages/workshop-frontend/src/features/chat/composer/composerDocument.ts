import type { OutputIcon, SlashCommandChoice } from "@gadgets/workshop-shared/api";
import type { ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  removeComposerToken,
  spliceComposerToken,
  type ComposerRange,
} from "../../../components/chat/composer-tokens";

export type ComposerCapsule = ComposerRange & {
  gatekeeperId: number;
  description: ResourceDescription;
  vendorId?: string;
};

export type ComposerFormatToken = ComposerRange & {
  noun: string;
  icon: OutputIcon;
  logo?: string;
};

export type ComposerSlashCommand = ComposerRange & {
  choice: SlashCommandChoice;
};

export type ComposerDocument = {
  text: string;
  capsules: ComposerCapsule[];
  formats: ComposerFormatToken[];
  command: ComposerSlashCommand | null;
};

export type ComposerDocumentCaretTransition = {
  document: ComposerDocument;
  caret: number;
};

export type ComposerTextEditTransition =
  | { document: ComposerDocument; rejected: true; caret: number }
  | { document: ComposerDocument; rejected?: false; caret?: number };

export type ComposerUrlRange = {
  text: string;
  start: number;
  end: number;
};

export type ComposerSelection = {
  start: number;
  end: number;
};

export type ComposerResourceRefinement = {
  document: ComposerDocument;
  activeUrl: ComposerUrlRange;
  selection: ComposerSelection;
};

const shiftRangeAfter = <T extends ComposerRange>(range: T, position: number, delta: number): T =>
  range.start >= position ? { ...range, start: range.start + delta } : range;

const overlapsDocumentToken = (
  document: ComposerDocument,
  start: number,
  end: number,
) => [
  ...document.capsules,
  ...document.formats,
  ...(document.command ? [document.command] : []),
].some((range) => start < range.start + range.length && end > range.start);

const isInsideDocumentToken = (document: ComposerDocument, position: number) => [
  ...document.capsules,
  ...document.formats,
  ...(document.command ? [document.command] : []),
].some((range) => position > range.start && position < range.start + range.length);

const shiftDocumentRanges = (
  document: ComposerDocument,
  position: number,
  delta: number,
) => ({
  capsules: document.capsules.map((capsule) => shiftRangeAfter(capsule, position, delta)),
  formats: document.formats.map((format) => shiftRangeAfter(format, position, delta)),
  command: document.command ? shiftRangeAfter(document.command, position, delta) : null,
});

export const insertComposerCapsule = (
  document: ComposerDocument,
  position: number,
  capsule: Omit<ComposerCapsule, "start" | "length">,
  capsuleText: string,
): ComposerDocumentCaretTransition | null => {
  if (!Number.isInteger(position) || position < 0 || position > document.text.length ||
      isInsideDocumentToken(document, position)) {
    return null;
  }
  const splice = spliceComposerToken(document.text, position, position, capsuleText);
  const shifted = shiftDocumentRanges(document, position, splice.delta);
  return {
    document: {
      text: splice.value,
      ...shifted,
      capsules: [
        ...shifted.capsules,
        { ...capsule, start: splice.start, length: splice.length },
      ],
    },
    caret: splice.caret,
  };
};

export const insertComposerFormat = (
  document: ComposerDocument,
  position: number,
  format: Omit<ComposerFormatToken, "start" | "length">,
  formatText: string,
): ComposerDocumentCaretTransition | null => {
  if (!Number.isInteger(position) || position < 0 || position > document.text.length ||
      isInsideDocumentToken(document, position)) {
    return null;
  }
  const splice = spliceComposerToken(document.text, position, position, formatText);
  const shifted = shiftDocumentRanges(document, position, splice.delta);
  return {
    document: {
      text: splice.value,
      ...shifted,
      formats: [
        ...shifted.formats,
        { ...format, start: splice.start, length: splice.length },
      ],
    },
    caret: splice.caret,
  };
};

export const replaceComposerUrlWithCapsule = (
  document: ComposerDocument,
  url: ComposerUrlRange,
  capsule: Omit<ComposerCapsule, "start" | "length">,
  capsuleText: string,
): ComposerDocumentCaretTransition | null => {
  if (url.start < 0 || url.end < url.start || url.end > document.text.length ||
      document.text.slice(url.start, url.end) !== url.text ||
      overlapsDocumentToken(document, url.start, url.end)) {
    return null;
  }
  const splice = spliceComposerToken(document.text, url.start, url.end, capsuleText);
  const shifted = shiftDocumentRanges(document, url.end, splice.delta);
  return {
    document: {
      text: splice.value,
      ...shifted,
      capsules: [
        ...shifted.capsules,
        { ...capsule, start: splice.start, length: splice.length },
      ],
    },
    caret: splice.caret,
  };
};

export const refineComposerResourceUrl = (
  document: ComposerDocument,
  url: ComposerUrlRange,
  newUrl: string,
  placeholder: ComposerSelection,
): ComposerResourceRefinement | null => {
  if (url.start < 0 || url.end < url.start || url.end > document.text.length ||
      document.text.slice(url.start, url.end) !== url.text ||
      overlapsDocumentToken(document, url.start, url.end) ||
      placeholder.start < 0 || placeholder.end < placeholder.start ||
      placeholder.end > newUrl.length) {
    return null;
  }
  const delta = newUrl.length - (url.end - url.start);
  return {
    document: {
      text: document.text.slice(0, url.start) + newUrl + document.text.slice(url.end),
      ...shiftDocumentRanges(document, url.end, delta),
    },
    activeUrl: { text: newUrl, start: url.start, end: url.start + newUrl.length },
    selection: {
      start: url.start + placeholder.start,
      end: url.start + placeholder.end,
    },
  };
};

export const removeComposerDocumentToken = (
  document: ComposerDocument,
  range: ComposerRange,
): ComposerDocumentCaretTransition => {
  const rangeEnd = range.start + range.length;
  const removal = removeComposerToken(document.text, range);
  return {
    document: {
      text: removal.value,
      capsules: document.capsules
        .filter((capsule) => capsule.start !== range.start)
        .map((capsule) => shiftRangeAfter(capsule, rangeEnd, removal.delta)),
      formats: document.formats
        .filter((format) => format.start !== range.start)
        .map((format) => shiftRangeAfter(format, rangeEnd, removal.delta)),
      command: !document.command || document.command.start === range.start
        ? null
        : shiftRangeAfter(document.command, rangeEnd, removal.delta),
    },
    caret: removal.caret,
  };
};

export const resolveComposerSlashCommand = (
  document: ComposerDocument,
  choice: SlashCommandChoice,
  tokenStart: number,
  tokenEnd: number,
  commandText: string,
): ComposerDocumentCaretTransition => {
  const splice = spliceComposerToken(document.text, tokenStart, tokenEnd, commandText);
  return {
    document: {
      text: splice.value,
      capsules: document.capsules.map((capsule) =>
        shiftRangeAfter(capsule, tokenEnd, splice.delta)),
      formats: document.formats.map((format) =>
        shiftRangeAfter(format, tokenEnd, splice.delta)),
      command: {
        choice,
        start: splice.start,
        length: commandText.length,
      },
    },
    caret: splice.caret,
  };
};

export const applyComposerTextEdit = (
  document: ComposerDocument,
  newText: string,
  editCursorPosition?: number,
): ComposerTextEditTransition => {
  const oldText = document.text;
  let editStart = 0;
  while (editStart < oldText.length && editStart < newText.length &&
      oldText[editStart] === newText[editStart]) {
    editStart++;
  }

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > editStart && newEnd > editStart &&
      oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  // The caret disambiguates edits inside repeated characters, where a prefix/suffix diff can pick
  // the wrong occurrence.
  if (editCursorPosition !== undefined && editCursorPosition < newEnd) {
    const insertedLength = newEnd - editStart;
    const deletedLength = oldEnd - editStart;
    const cursorBasedStart = editCursorPosition - insertedLength;
    if (cursorBasedStart >= 0) {
      editStart = cursorBasedStart;
      newEnd = editCursorPosition;
      oldEnd = cursorBasedStart + deletedLength;
    }
  }

  const isPureInsertion = oldEnd === editStart;
  if (isPureInsertion && document.capsules.some((capsule) =>
      editStart > capsule.start && editStart < capsule.start + capsule.length)) {
    return { document, caret: editStart, rejected: true };
  }

  const commandEdited = document.command !== null &&
    editStart < document.command.start + document.command.length &&
    oldEnd > document.command.start;
  const editedFormatStarts = new Set(document.formats
    .filter((format) => editStart < format.start + format.length && oldEnd > format.start)
    .map((format) => format.start));
  const brokenCapsules = document.capsules
    .filter((capsule) => editStart < capsule.start + capsule.length && oldEnd > capsule.start)
    .toSorted((a, b) => b.start - a.start);
  const editShift = newEnd - oldEnd;

  let adjustedText = newText;
  let extraShift = 0;
  for (const capsule of brokenCapsules) {
    let remainingStart = capsule.start;
    let remainingEnd = capsule.start + capsule.length;
    if (remainingStart >= oldEnd) {
      remainingStart += editShift;
      remainingEnd += editShift;
    } else {
      remainingStart = Math.min(remainingStart, editStart);
      const lengthAfterEdit = capsule.start + capsule.length - oldEnd;
      remainingEnd = lengthAfterEdit > 0 ? newEnd + lengthAfterEdit : newEnd;
    }
    const removeLength = remainingEnd - remainingStart;
    if (removeLength > 0 && remainingStart < adjustedText.length) {
      adjustedText = adjustedText.slice(0, remainingStart) +
        adjustedText.slice(Math.min(remainingEnd, adjustedText.length));
      extraShift -= removeLength;
    }
  }

  const totalShift = editShift + extraShift;
  const brokenCapsuleStarts = new Set(brokenCapsules.map((capsule) => capsule.start));
  const shiftSurvivor = <T extends ComposerRange>(range: T): T =>
    shiftRangeAfter(range, oldEnd, totalShift);

  return {
    document: {
      text: adjustedText,
      capsules: document.capsules
        .filter((capsule) => !brokenCapsuleStarts.has(capsule.start))
        .map(shiftSurvivor),
      formats: document.formats
        .filter((format) => !editedFormatStarts.has(format.start))
        .map(shiftSurvivor),
      command: commandEdited || !document.command ? null : shiftSurvivor(document.command),
    },
    ...(brokenCapsules.length > 0
      ? { caret: brokenCapsules[brokenCapsules.length - 1].start }
      : {}),
  };
};
