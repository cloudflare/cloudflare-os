import type {
  CapsuleSpecifier,
  MessageFormatRef,
  SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import { locateMessageFormatRefs } from "../../../components/format/messageFormatRefs";
import type { ComposerDocument } from "./composerDocument";
import { stripSlashCommandToken } from "../../../components/chat/slash-command-input";

export type ComposerSubmission = {
  message: string | SlashCommandRequest;
  capsules?: CapsuleSpecifier[];
  formats?: MessageFormatRef[];
};

export type ComposerSubmissionResult =
  | { ok: true; submission: ComposerSubmission }
  | { ok: false; error: "slash-command-with-extras" };

export const buildComposerSubmission = ({
  document: { text, capsules, formats, command },
  hasAttachments,
}: {
  document: ComposerDocument;
  hasAttachments: boolean;
}): ComposerSubmissionResult => {
  const formatShiftBefore = (position: number) => {
    let delta = 0;
    for (const format of formats) {
      if (format.start + format.length <= position) {
        delta += format.noun.length - format.length;
      }
    }
    return delta;
  };

  let messageText = text;
  let adjustedCapsules = capsules;
  if (formats.length > 0) {
    for (const format of [...formats].toSorted((a, b) => b.start - a.start)) {
      messageText = messageText.slice(0, format.start) + format.noun +
        messageText.slice(format.start + format.length);
    }
    adjustedCapsules = capsules.map((capsule) => {
      const delta = formatShiftBefore(capsule.start);
      return delta === 0 ? capsule : { ...capsule, start: Math.max(0, capsule.start + delta) };
    });
  }

  let commandPosition: number | undefined;
  if (command) {
    const stripped = stripSlashCommandToken(messageText, {
      start: command.start + formatShiftBefore(command.start),
      length: command.length,
    });
    messageText = stripped.args;
    commandPosition = stripped.commandPosition;
  }

  if (command && (adjustedCapsules.length > 0 || hasAttachments)) {
    return { ok: false, error: "slash-command-with-extras" };
  }

  let message: string | SlashCommandRequest = command
    ? {
        id: command.choice.selection,
        args: messageText.trim(),
        ...(commandPosition ? { commandPosition } : {}),
      }
    : messageText;
  let capsuleSpecifiers: CapsuleSpecifier[] | undefined;

  if (typeof message === "string" && adjustedCapsules.length > 0) {
    const sortedCapsules = [...adjustedCapsules].toSorted((a, b) => a.start - b.start);
    let processedMessage = messageText;
    let cumulativeShift = 0;
    capsuleSpecifiers = [];

    for (const [index, capsule] of sortedCapsules.entries()) {
      const placeholder = `[${index}]`;
      const adjustedStart = capsule.start + cumulativeShift;
      processedMessage = processedMessage.slice(0, adjustedStart) + placeholder +
        processedMessage.slice(adjustedStart + capsule.length);
      capsuleSpecifiers.push({
        position: adjustedStart,
        length: placeholder.length,
        gatekeeperId: capsule.gatekeeperId,
        description: capsule.description,
        vendorId: capsule.vendorId,
      });
      cumulativeShift += placeholder.length - capsule.length;
    }
    message = processedMessage;
  }

  if (typeof message === "string") {
    const leadingWhitespace = message.length - message.trimStart().length;
    if (leadingWhitespace > 0) {
      capsuleSpecifiers = capsuleSpecifiers?.map((specifier) => ({
        ...specifier,
        position: Math.max(0, specifier.position - leadingWhitespace),
      }));
    }
    message = message.trim();
  }

  const formatRefs = locateMessageFormatRefs(
    typeof message === "string" ? message : message.args,
    [...formats].toSorted((a, b) => a.start - b.start),
  );

  return {
    ok: true,
    submission: {
      message,
      ...(capsuleSpecifiers?.length ? { capsules: capsuleSpecifiers } : {}),
      ...(formatRefs ? { formats: formatRefs } : {}),
    },
  };
};
