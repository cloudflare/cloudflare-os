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
import type { ComposerDocumentSnapshot } from "./draft/useComposerDraft";

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
  ) => CommittedTransition<T>;
  capsuleTokenText: (description: ResourceDescription, vendorId?: string) => string;
  onSelectionRequest: (selection: ComposerSelection, documentRevision: number) => void;
  onError: (message: string) => void;
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
      try {
        const [gatekeeperId, description] = await Promise.all([
          gatekeeper.getId(),
          gatekeeper.describe(),
        ]);
        if (operationRef.current !== operation) return;
        const result = commitDocumentEdit(source.snapshot, (document) =>
          replaceComposerUrlWithCapsule(
            document,
            source,
            { gatekeeperId, description, vendorId },
            capsuleTokenText(description, vendorId),
          ));
        if (!result) {
          onError("The prompt changed before the resource could be added");
          dismissUrl();
          return;
        }
        dismissUrl();
        onSelectionRequest({ start: result.caret, end: result.caret }, result.documentRevision);
      } finally {
        gatekeeper[Symbol.dispose]();
      }
    } catch (error) {
      if (operationRef.current !== operation) return;
      console.error("Failed to create capsule:", error);
      onError("Failed to add resource");
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
    try {
      const [gatekeeperId, description, creationSpec] = await Promise.all([
        gatekeeper.getId(),
        gatekeeper.describe(),
        gatekeeper.getCreationSpec(),
      ]);
      if (!source || attachSnapshotRef.current !== source) return;
      const vendorId = creationSpec.type === "gatekeeper" ? creationSpec.vendorId : undefined;
      const result = commitDocumentEdit(source.snapshot, (document) =>
        insertComposerCapsule(
          document,
          source.position,
          { gatekeeperId, description, vendorId },
          capsuleTokenText(description, vendorId),
        ));
      closeAttachModal();
      if (!result) {
        onError("The prompt changed before the resource could be added");
        return;
      }
      onSelectionRequest({ start: result.caret, end: result.caret }, result.documentRevision);
    } catch (error) {
      if (attachSnapshotRef.current !== source) return;
      throw error;
    } finally {
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
    openAttachModal,
    refineUrl,
    scanAt,
  };
};
