import {codeChangeSerializedSize, composeCodeChange, MAX_CODE_CHANGE_SIZE,
  validateCodeChangeSchema, type CodeChange, type FileChange} from "@gadgets/workshop-shared/code-change";
import type {ChangeBatch} from "./agent-compaction";
import type {WorktreeBaseChangeRecord} from "./storage-schema/overseer-storage";

/** Compose the ordered, bounded storage chunks without deriving operations from file contents. */
export function composeWorktreeBaseChanges(id: number, records: Iterable<WorktreeBaseChangeRecord>): CodeChange {
  let result: CodeChange = {};
  for (const record of [...records].toSorted((a, b) => (a.part ?? 0) - (b.part ?? 0))) {
    result = composeCodeChange(result, {[id]: [[record.path, record.change]]});
  }
  return result;
}

/** Prepare a bounded accepted prefix before publishing an epoch reset or advancing its pin. */
export function prepareWorktreeBaseChanges(id: number, records: Iterable<WorktreeBaseChangeRecord>,
    batches: Iterable<ChangeBatch>): WorktreeBaseChangeRecord[] {
  const accepted = new Map<string, FileChange[]>();
  // Share the epoch fold's re-root rule, but retain its original bounded batches rather than
  // composing a possibly huge set and then splitting/re-diffing the resulting text.
  for (const {change, pins} of batches) {
    if (pins?.some(pin => pin.gadgetId === id)) accepted.clear();
    for (const [path, operation] of change?.[id] ?? []) {
      if (!accepted.has(path)) accepted.set(path, []);
      accepted.get(path)!.push(operation);
    }
  }
  const paths = new Map<string, FileChange[]>();
  for (const record of [...records].toSorted((a, b) => (a.part ?? 0) - (b.part ?? 0))) {
    if (!paths.has(record.path)) paths.set(record.path, []);
    paths.get(record.path)!.push(record.change);
  }
  for (const [path, operations] of accepted) {
    const parts = paths.get(path) ?? [];
    for (const operation of operations) {
      const incoming = {[id]: [[path, operation]]} satisfies CodeChange;
      validateCodeChangeSchema(incoming);
      if (!parts.length || "set" in operation || "remove" in operation) {
        parts.splice(0, parts.length, operation);
      } else {
        const combined = composeCodeChange({[id]: [[path, parts.at(-1)!]]}, incoming);
        if (codeChangeSerializedSize(combined) <= MAX_CODE_CHANGE_SIZE) {
          parts[parts.length - 1] = combined[id][0][1];
        } else {
          parts.push(operation);
        }
      }
    }
    paths.set(path, parts);
  }
  return [...paths].flatMap(([path, parts]) => parts.map((change, part) => {
    validateCodeChangeSchema({[id]: [[path, change]]});
    return {workpieceId: id, path, change, ...(part ? {part} : {})};
  }));
}
