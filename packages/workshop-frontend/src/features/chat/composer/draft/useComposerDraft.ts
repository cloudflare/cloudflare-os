import { useEffect, useRef, useState } from "react";
import { formatIconDataUrl } from "../../../../components/format/formatIconImage";
import { slashCommandKey } from "../../../../components/chat/slash-command-catalog";
import type { ComposerDocument } from "../composerDocument";
import {
  decorateComposerDraft,
  readComposerDraft,
  serializeComposerDraft,
  writeComposerDraft,
  type StoredComposerDraft,
} from "./composerDraft";

export type DraftPresentationRequest = {
  id: number;
  text: string;
};

export type ComposerDocumentSnapshot = {
  document: ComposerDocument;
  documentRevision: number;
  editRevision: number;
  presentationRevision: number;
};

export type CommitDocumentEditOptions = {
  allowPresentationChanges?: boolean;
};

export const composerDocumentFromDraft = (
  draft: StoredComposerDraft | undefined,
): ComposerDocument => ({
  text: draft?.text ?? "",
  capsules: [],
  formats: draft?.formats.map(({ position, length, noun, icon }) => ({
    start: position,
    length,
    noun,
    icon,
  })) ?? [],
  command: draft?.command
    ? {
        start: draft.command.position,
        length: draft.command.length,
        choice: draft.command.choice,
      }
    : null,
});

const storedDraftFromDocument = (document: ComposerDocument): StoredComposerDraft =>
  serializeComposerDraft(
    document.text,
    document.capsules.map(({ start, length, description }) => ({
      start,
      length,
      url: description.url,
    })),
    document.formats,
    document.command ?? undefined,
  );

const documentMatchesStoredDraft = (
  document: ComposerDocument,
  draft: StoredComposerDraft,
) => {
  const storedCommand = draft.command;
  if (document.text !== draft.text || document.capsules.length > 0 ||
      !!document.command !== !!storedCommand || document.command && storedCommand &&
      (document.command.start !== storedCommand.position ||
        document.command.length !== storedCommand.length ||
        slashCommandKey(document.command.choice.selection) !==
          slashCommandKey(storedCommand.choice.selection))) {
    return false;
  }
  return document.formats.length === draft.formats.length &&
    document.formats.every((format, index) => {
      const stored = draft.formats[index];
      return !format.logo && format.start === stored.position && format.length === stored.length &&
        format.noun === stored.noun && format.icon === stored.icon;
    });
};

const storedDraftsMatch = (
  first: StoredComposerDraft | undefined,
  second: StoredComposerDraft,
) => first !== undefined && JSON.stringify(first) === JSON.stringify(second);

const composerDocumentsMatch = (first: ComposerDocument, second: ComposerDocument) =>
  JSON.stringify(first) === JSON.stringify(second);

export const useComposerDraft = ({
  storageKey,
  logoSlot,
}: {
  storageKey: string | undefined;
  logoSlot: string;
}) => {
  const [initialDraft] = useState(() => readComposerDraft(storageKey));
  const [document, setDocument] = useState<ComposerDocument>(() =>
    composerDocumentFromDraft(initialDraft));
  const [presentationRequest, setPresentationRequest] =
    useState<DraftPresentationRequest>();
  const documentRef = useRef(document);
  const loadedKeyRef = useRef(storageKey);
  const editedRef = useRef(false);
  const editRevisionRef = useRef(0);
  const documentRevisionRef = useRef(0);
  const presentationRevisionRef = useRef(0);
  const skipWriteRef = useRef(false);
  const restoreGenerationRef = useRef(0);
  const presentationIdRef = useRef(0);
  documentRef.current = document;

  const setCurrentDocument = (nextDocument: ComposerDocument) => {
    documentRef.current = nextDocument;
    documentRevisionRef.current++;
    setDocument(nextDocument);
  };

  const setPresentationDocument = (nextDocument: ComposerDocument) => {
    presentationRevisionRef.current++;
    setCurrentDocument(nextDocument);
  };

  const requestPresentation = (text: string, key: string | undefined, generation: number) => {
    if (restoreGenerationRef.current !== generation || loadedKeyRef.current !== key) return;
    setPresentationRequest({ id: ++presentationIdRef.current, text });
  };

  const restorePresentation = (
    draft: StoredComposerDraft,
    key: string | undefined,
    generation: number,
  ) => {
    requestPresentation(draft.text, key, generation);
    if (draft.formats.length === 0 && !draft.command) return;

    void Promise.all(draft.formats.map(({ icon }) => formatIconDataUrl(icon))).then((logos) => {
      requestAnimationFrame(() => {
        if (restoreGenerationRef.current !== generation || loadedKeyRef.current !== key ||
            !documentMatchesStoredDraft(documentRef.current, draft)) {
          return;
        }
        const restored = decorateComposerDraft(draft, logos, logoSlot);
        setPresentationDocument({
          text: restored.text,
          capsules: [],
          formats: restored.formats,
          command: restored.command ?? null,
        });
        requestPresentation(restored.text, key, generation);
      });
    });
  };

  useEffect(() => {
    if (!initialDraft) return;
    const generation = ++restoreGenerationRef.current;
    restorePresentation(initialDraft, storageKey, generation);
    return () => {
      if (restoreGenerationRef.current === generation) restoreGenerationRef.current++;
    };
    // This restoration belongs to the draft captured during initialization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (loadedKeyRef.current === storageKey) return;
    const generation = ++restoreGenerationRef.current;
    const previousKey = loadedKeyRef.current;
    loadedKeyRef.current = storageKey;
    skipWriteRef.current = true;
    setPresentationRequest(undefined);
    const storedDraft = readComposerDraft(storageKey);
    const currentDocument = documentRef.current;
    const preserveLocalDraft = previousKey === undefined &&
      (editedRef.current || currentDocument.text.length > 0);
    if (preserveLocalDraft) {
      writeComposerDraft(storageKey, storedDraftFromDocument(currentDocument));
      skipWriteRef.current = false;
      return;
    }

    if (previousKey !== undefined) editedRef.current = false;
    const nextDocument = {
      ...composerDocumentFromDraft(storedDraft),
      capsules: previousKey === undefined ? currentDocument.capsules : [],
    };
    if (previousKey !== undefined || !composerDocumentsMatch(currentDocument, nextDocument)) {
      setCurrentDocument(nextDocument);
    }
    if (storedDraft) restorePresentation(storedDraft, storageKey, generation);
    return () => {
      if (restoreGenerationRef.current === generation) restoreGenerationRef.current++;
    };
  }, [storageKey]);

  useEffect(() => {
    if (skipWriteRef.current) {
      skipWriteRef.current = false;
      return;
    }
    writeComposerDraft(storageKey, storedDraftFromDocument(document));
  }, [document, storageKey]);

  const recordEdit = () => {
    editedRef.current = true;
    editRevisionRef.current++;
    restoreGenerationRef.current++;
    setPresentationRequest(undefined);
  };

  const beginSend = () => ({
    key: loadedKeyRef.current,
    editRevision: editRevisionRef.current,
    draft: storedDraftFromDocument(documentRef.current),
  });

  const completeSend = (send: ReturnType<typeof beginSend>): boolean => {
    if (loadedKeyRef.current !== send.key) {
      if (storedDraftsMatch(readComposerDraft(send.key), send.draft)) {
        writeComposerDraft(send.key, undefined);
      }
      return false;
    }
    if (editRevisionRef.current !== send.editRevision) return false;
    writeComposerDraft(send.key, undefined);
    editedRef.current = false;
    return true;
  };

  const updateDocument = (update: (current: ComposerDocument) => ComposerDocument) => {
    setCurrentDocument(update(documentRef.current));
  };

  const replaceDocument = (nextDocument: ComposerDocument) => {
    setCurrentDocument(nextDocument);
  };

  const getDocumentSnapshot = (): ComposerDocumentSnapshot => ({
    document: documentRef.current,
    documentRevision: documentRevisionRef.current,
    editRevision: editRevisionRef.current,
    presentationRevision: presentationRevisionRef.current,
  });

  const commitDocumentEdit = <T extends { document: ComposerDocument }>(
    snapshot: ComposerDocumentSnapshot,
    transition: (current: ComposerDocument) => T | null,
    options?: CommitDocumentEditOptions,
  ): (T & { documentRevision: number; editRevision: number }) | null => {
    if (documentRevisionRef.current !== snapshot.documentRevision) {
      const documentChanges = documentRevisionRef.current - snapshot.documentRevision;
      const presentationChanges =
        presentationRevisionRef.current - snapshot.presentationRevision;
      if (!options?.allowPresentationChanges || documentChanges !== presentationChanges) {
        return null;
      }
    }
    const result = transition(documentRef.current);
    if (!result) return null;
    recordEdit();
    setCurrentDocument(result.document);
    return {
      ...result,
      documentRevision: documentRevisionRef.current,
      editRevision: editRevisionRef.current,
    };
  };

  return {
    beginSend,
    commitDocumentEdit,
    completeSend,
    document,
    getDocumentSnapshot,
    presentationRequest,
    recordEdit,
    replaceDocument,
    updateDocument,
  };
};
