import { useEffect, useRef, useState } from "react";
import type { RpcStub } from "capnweb";
import type { GatekeeperClient } from "@gadgets/workshop-shared/api";
import type { ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import { normalizeResourceUrl } from "../../../resourceMatching";
import {
  insertComposerCapsule,
  refineComposerResourceUrl,
  replaceComposerUrlWithCapsule,
  type ComposerDocument,
  type ComposerSelection,
  type ComposerUrlRange,
} from "./composerDocument";
import type {
  CommitDocumentEditOptions,
  ComposerDocumentSnapshot,
} from "./draft/useComposerDraft";

const URL_REGEX = /https?:\/\/[^\s)>\]]*/g;

type CommittedTransition<T extends { document: ComposerDocument }> =
  (T & { documentRevision: number; editRevision: number }) | null;

type ActiveResourceUrl = ComposerUrlRange & {
  snapshot: ComposerDocumentSnapshot;
};

type UseComposerResourcesOptions = {
  createCapsuleGatekeeper: (
    accountId: number,
    url: string,
  ) => Promise<RpcStub<GatekeeperClient<any>> | null>;
  getDocumentSnapshot: () => ComposerDocumentSnapshot;
  commitDocumentEdit: <T extends { document: ComposerDocument }>(
    snapshot: ComposerDocumentSnapshot,
    transition: (current: ComposerDocument) => T | null,
    options?: CommitDocumentEditOptions,
  ) => CommittedTransition<T>;
  capsuleTokenText: (description: ResourceDescription, vendorId?: string) => string;
  onSelectionRequest: (selection: ComposerSelection, documentRevision: number) => void;
  onError: (message: string) => void;
};

const currentResourceUrl = (
  source: ActiveResourceUrl,
  document: ComposerDocument,
): ComposerUrlRange | null => {
  const originalUrls = [
    ...source.snapshot.document.text.matchAll(/https?:\/\/[^\s)>\]]*/g),
  ];
  const sourceIndex = originalUrls.findIndex((match) =>
    match.index === source.start && match.index + match[0].length === source.end &&
    match[0] === source.text);
  if (sourceIndex < 0) return null;

  const match = [...document.text.matchAll(/https?:\/\/[^\s)>\]]*/g)][sourceIndex];
  if (!match || match[0] !== source.text) return null;
  return { text: match[0], start: match.index, end: match.index + match[0].length };
};

const currentPresentationPosition = (
  source: ComposerDocumentSnapshot,
  document: ComposerDocument,
  position: number,
): number | null => {
  if (source.document.formats.length !== document.formats.length) return null;
  let shift = 0;
  for (const [index, previous] of source.document.formats.entries()) {
    const current = document.formats[index];
    if (current.noun !== previous.noun || current.icon !== previous.icon ||
        current.start !== previous.start + shift) {
      return null;
    }
    if (position > previous.start && position < previous.start + previous.length) return null;
    if (position >= previous.start + previous.length) {
      shift += current.length - previous.length;
    }
  }
  return position + shift;
};

const removeUnusedGatekeeper = async (gatekeeper: RpcStub<GatekeeperClient<any>>) => {
  try {
    await gatekeeper.remove();
  } catch (error) {
    console.error("Failed to remove unused resource connection:", error);
  }
};

export const useComposerResources = ({
  createCapsuleGatekeeper,
  getDocumentSnapshot,
  commitDocumentEdit,
  capsuleTokenText,
  onSelectionRequest,
  onError,
}: UseComposerResourcesOptions) => {
  const [activeUrl, setActiveUrl] = useState<ActiveResourceUrl | null>(null);
  const [attachModalOpen, setAttachModalOpen] = useState(false);
  const [isCreatingResource, setIsCreatingResource] = useState(false);
  const activeUrlRef = useRef(activeUrl);
  const attachSnapshotRef = useRef<{
    snapshot: ComposerDocumentSnapshot;
    position: number;
  } | undefined>(undefined);
  const operationRef = useRef(0);
  const lastScanRef = useRef({ position: -1, text: "", documentRevision: -1 });
  activeUrlRef.current = activeUrl;

  useEffect(() => () => {
    operationRef.current++;
    attachSnapshotRef.current = undefined;
  }, []);

  const hideUrl = () => {
    activeUrlRef.current = null;
    setActiveUrl(null);
  };

  const dismissUrl = () => {
    operationRef.current++;
    setIsCreatingResource(false);
    hideUrl();
  };

  const scanAt = (position: number) => {
    const snapshot = getDocumentSnapshot();
    const { document, documentRevision } = snapshot;
    const scanned = lastScanRef.current;
    if (scanned.position === position && scanned.text === document.text &&
        scanned.documentRevision === documentRevision) {
      return;
    }
    lastScanRef.current = { position, text: document.text, documentRevision };

    URL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = URL_REGEX.exec(document.text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position < start || position > end) continue;
      const isCapsule = document.capsules.some((capsule) =>
        start >= capsule.start && end <= capsule.start + capsule.length);
      if (isCapsule) break;

      const previous = activeUrlRef.current;
      if (previous?.text === match[0] && previous.start === start && previous.end === end &&
          previous.snapshot.documentRevision === documentRevision) {
        return;
      }
      const next = { text: match[0], start, end, snapshot };
      activeUrlRef.current = next;
      setActiveUrl(next);
      return;
    }
    hideUrl();
  };

  const createCapsule = async (accountId: number, vendorId: string) => {
    const source = activeUrlRef.current;
    if (!source) return;
    const operation = ++operationRef.current;
    setIsCreatingResource(true);
    try {
      const gatekeeper = await createCapsuleGatekeeper(
        accountId,
        normalizeResourceUrl(source.text),
      );
      if (!gatekeeper) {
        if (operationRef.current !== operation) return;
        onError("Failed to create resource connection");
        return;
      }
      let inserted = false;
      try {
        const [gatekeeperId, description] = await Promise.all([
          gatekeeper.getId(),
          gatekeeper.describe(),
        ]);
        if (operationRef.current !== operation) return;
        const result = commitDocumentEdit(source.snapshot, (document) => {
          const url = currentResourceUrl(source, document);
          return url && replaceComposerUrlWithCapsule(
            document,
            url,
            { gatekeeperId, description, vendorId },
            capsuleTokenText(description, vendorId),
          );
        }, { allowPresentationChanges: true });
        if (!result) {
          onError("The prompt changed before the resource could be added");
          dismissUrl();
          return;
        }
        inserted = true;
        dismissUrl();
        onSelectionRequest({ start: result.caret, end: result.caret }, result.documentRevision);
      } finally {
        if (!inserted) await removeUnusedGatekeeper(gatekeeper);
        gatekeeper[Symbol.dispose]();
      }
    } catch (error) {
      if (operationRef.current !== operation) return;
      console.error("Failed to create capsule:", error);
      onError("Failed to add resource");
    } finally {
      if (operationRef.current === operation) setIsCreatingResource(false);
    }
  };

  const refineUrl = (newUrl: string, placeholderStart: number, placeholderEnd: number) => {
    const source = activeUrlRef.current;
    if (!source) return;
    const result = commitDocumentEdit(source.snapshot, (document) =>
      refineComposerResourceUrl(
        document,
        source,
        newUrl,
        { start: placeholderStart, end: placeholderEnd },
      ));
    if (!result) {
      dismissUrl();
      return;
    }
    const next = {
      ...result.activeUrl,
      snapshot: getDocumentSnapshot(),
    };
    activeUrlRef.current = next;
    setActiveUrl(next);
    onSelectionRequest(result.selection, result.documentRevision);
  };

  const openAttachModal = (position: number) => {
    const snapshot = getDocumentSnapshot();
    if (position < 0 || position > snapshot.document.text.length) {
      return;
    }
    attachSnapshotRef.current = { snapshot, position };
    setAttachModalOpen(true);
  };

  const closeAttachModal = () => {
    attachSnapshotRef.current = undefined;
    setAttachModalOpen(false);
  };

  const attachCreated = async (gatekeeper: RpcStub<GatekeeperClient<any>>) => {
    const source = attachSnapshotRef.current;
    let inserted = false;
    try {
      if (!source || attachSnapshotRef.current !== source) return;
      const [gatekeeperId, description, creationSpec] = await Promise.all([
        gatekeeper.getId(),
        gatekeeper.describe(),
        gatekeeper.getCreationSpec(),
      ]);
      if (!source || attachSnapshotRef.current !== source) return;
      const vendorId = creationSpec.type === "gatekeeper" ? creationSpec.vendorId : undefined;
      const result = commitDocumentEdit(source.snapshot, (document) => {
        const position = currentPresentationPosition(source.snapshot, document, source.position);
        return position === null ? null : insertComposerCapsule(
          document,
          position,
          { gatekeeperId, description, vendorId },
          capsuleTokenText(description, vendorId),
        );
      }, { allowPresentationChanges: true });
      closeAttachModal();
      if (!result) {
        onError("The prompt changed before the resource could be added");
        return;
      }
      inserted = true;
      onSelectionRequest({ start: result.caret, end: result.caret }, result.documentRevision);
    } catch (error) {
      if (attachSnapshotRef.current !== source) return;
      throw error;
    } finally {
      if (!inserted) await removeUnusedGatekeeper(gatekeeper);
      gatekeeper[Symbol.dispose]();
    }
  };

  return {
    activeUrl,
    attachCreated,
    attachModalOpen,
    closeAttachModal,
    createCapsule,
    dismissUrl,
    isCreatingResource,
    openAttachModal,
    refineUrl,
    scanAt,
  };
};
