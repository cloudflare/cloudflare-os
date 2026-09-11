import {
  Badge,
  Banner,
  Button,
  Collapsible,
  Dialog,
  Input,
  InputArea,
  Label,
  LayerCard,
  Select,
  Text,
  useKumoToastManager,
} from "@cloudflare/kumo";
import {
  CaretRight,
  FileText,
  FolderOpen,
  ScrollIcon,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useRef, useState } from "react";
import type { ContextDocumentSummary, EnabledCollectionInfo } from "../../src/context-types";
import { extractDescription } from "../../src/description-extractors";
import { useContextApi } from "../bridge";
import { readDroppedUploadFiles, readUploadFiles, type DecodedUploadFile } from "../uploadFiles";
import { buildNewSkillLocation, isValidSkillDescription } from "./addSkillNavigatorNode";
import { humanizeSkillName, isValidSkillName, sanitizeSkillTitle, skillNameFromTitle } from "./skillName";
import {
  prepareSkillUploads,
  writeSkillUploadMetadata,
  type SkillUploadCandidate,
} from "./skillUpload";
import { useMutationDialog } from "./useMutationDialog";

type UploadSkillsDialogProps = {
  target: UploadSkillsTarget;
  collections: readonly EnabledCollectionInfo[];
  writableCollections: readonly EnabledCollectionInfo[];
  documents: ReadonlyMap<string, readonly ContextDocumentSummary[]>;
  onUploaded: () => void;
  onClose: () => void;
};

/** Destination and collection-selection behavior for uploaded skills. */
export type UploadSkillsTarget = {
  collectionId: string;
  directoryPath: string;
  collectionEditable: boolean;
};

type EditableCandidate = SkillUploadCandidate & { title: string; open: boolean };

/** Imports standalone Markdown skills or complete skill folders into a writable collection. */
export const UploadSkillsDialog = ({
  target,
  collections,
  writableCollections,
  documents,
  onUploaded,
  onClose,
}: UploadSkillsDialogProps) => {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [collectionId, setCollectionId] = useState(
    target.collectionId || writableCollections[0]?.id || "",
  );
  const [candidates, setCandidates] = useState<EditableCandidate[]>([]);
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [finished, setFinished] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const selectionIdRef = useRef(0);
  const dialog = useMutationDialog(reading || uploading, onClose);

  const addFiles = async (readFiles: () => Promise<DecodedUploadFile[]>) => {
    setReading(true);
    setFinished(false);
    setFailures([]);
    try {
      const selectionId = selectionIdRef.current++;
      const prepared = prepareSkillUploads(await readFiles());
      const editable = prepared.map((candidate) => ({
        ...candidate,
        id: `${selectionId}:${candidate.id}`,
        title: humanizeSkillName(candidate.name),
        open: candidate.metadataError !== null,
      }));
      setCandidates((current) => [...(finished ? [] : current), ...editable]);
      if (prepared.length === 0) {
        toasts.add({ title: "No Markdown skills were found", variant: "error" });
      }
    } catch (error) {
      setCandidates([]);
      toasts.add({
        title: error instanceof Error ? error.message : "Selected files could not be read",
        variant: "error",
      });
    } finally {
      setReading(false);
    }
  };

  const chooseFiles = (files: FileList) => addFiles(
    () => readUploadFiles(Array.from(files), { inferUnknownBinary: true }),
  );

  const updateCandidate = (id: string, patch: Partial<EditableCandidate>) => {
    setCandidates((current) => current.map(
      (candidate) => candidate.id === id ? { ...candidate, ...patch } : candidate,
    ));
  };

  const valid = !finished && Boolean(collectionId) && candidates.length > 0
    && candidates.every((candidate) => (
      isValidSkillName(skillNameFromTitle(candidate.title))
      && isValidSkillDescription(candidate.description)
    ));

  const upload = async () => {
    if (!valid || uploading) return;
    setUploading(true);
    setFailures([]);
    const existingDocuments = new Map(documents);
    const collectionDocuments = [...(existingDocuments.get(collectionId) ?? [])];
    existingDocuments.set(collectionId, collectionDocuments);
    const nextFailures: string[] = [];
    let uploaded = 0;
    let created = 0;

    for (const candidate of candidates) {
      const requestedName = skillNameFromTitle(candidate.title);
      const location = buildNewSkillLocation(
        existingDocuments,
        collectionId,
        target.directoryPath,
        requestedName,
      );
      collectionDocuments.push({
        path: location.path,
        name: "SKILL.md",
        description: candidate.description.trim(),
        contentType: "text/markdown",
        lastUpdated: new Date(),
      });

      try {
        await context.createContextSkill(collectionId, location.path, {
          description: candidate.description.trim(),
          body: writeSkillUploadMetadata(
            candidate.manifestBody,
            location.name,
            candidate.description,
          ),
          contentType: "text/markdown",
        });
      } catch (error) {
        nextFailures.push(`${candidate.label}: ${error instanceof Error ? error.message : "upload failed"}`);
        continue;
      }
      created++;

      const supportResults: PromiseSettledResult<void>[] = [];
      for (let index = 0; index < candidate.supportingFiles.length; index += 6) {
        const batch = candidate.supportingFiles.slice(index, index + 6);
        supportResults.push(...await Promise.allSettled(batch.map((file) => (
          context.putContextDocument(collectionId, `${location.directory}/${file.path}`, {
            description: extractDescription(file.contentType, file.body) ?? "",
            body: file.body,
            contentType: file.contentType,
          })
        ))));
      }
      const failedSupportFiles = supportResults.flatMap((result, index) => (
        result.status === "rejected" ? [candidate.supportingFiles[index].path] : []
      ));
      if (failedSupportFiles.length > 0) {
        const displayedFiles = failedSupportFiles.slice(0, 3).join(", ");
        const remaining = failedSupportFiles.length - 3;
        nextFailures.push(
          `${candidate.label}: added without ${displayedFiles}${remaining > 0 ? ` and ${remaining} more` : ""}`,
        );
      } else {
        uploaded++;
      }
    }

    if (created > 0) onUploaded();
    if (nextFailures.length === 0) {
      toasts.add({
        title: `Uploaded ${uploaded} ${uploaded === 1 ? "skill" : "skills"}`,
        variant: "success",
      });
      dialog.closeAfterSuccess();
    } else {
      setFinished(true);
      setFailures(nextFailures);
      toasts.add({
        title: `${uploaded} ${uploaded === 1 ? "skill" : "skills"} uploaded, ${nextFailures.length} need attention`,
        variant: "error",
      });
    }
    setUploading(false);
  };

  return (
    <Dialog.Root
      open={dialog.open}
      onOpenChange={(open) => { if (!open) dialog.requestClose(); }}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
    >
      <Dialog className="top-[8%]! flex max-h-[84vh] w-[min(620px,calc(100vw-32px))]! translate-y-0! flex-col overflow-hidden bg-kumo-base p-0" size="lg">
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-6">
          <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
            Upload skills
          </Dialog.Title>
          <Dialog.Close
            disabled={reading || uploading}
            render={(props) => (
              <Button {...props} variant="ghost" shape="square" aria-label="Close">
                <X size={18} />
              </Button>
            )}
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-5 sm:px-6">
          {target.collectionEditable && (
            <Select
              label="Target collection"
              className="w-full"
              placeholder="Select a collection"
              value={collectionId}
              onValueChange={(value) => setCollectionId(value as string)}
              renderValue={(id) => {
                const collection = collections.find((candidate) => candidate.id === id);
                if (!collection) return "Select a collection";
                return (
                  <span className="flex items-center gap-2">
                    {collection.icon ? <span>{collection.icon}</span> : null}
                    <span className="truncate">{collection.title}</span>
                  </span>
                );
              }}
            >
              {writableCollections.map((collection) => (
                <Select.Option key={collection.id} value={collection.id}>
                  <span className="flex items-center gap-2">
                    {collection.icon ? <span>{collection.icon}</span> : null}
                    <span className="truncate">{collection.title}</span>
                  </span>
                </Select.Option>
              ))}
            </Select>
          )}

          {candidates.length > 0 && (
            <div
              role="group"
              aria-labelledby="skills-to-upload-label"
              className="flex flex-col gap-2"
            >
              <span id="skills-to-upload-label"><Label>Skills to upload</Label></span>
              {candidates.map((candidate) => {
                const nameError = isValidSkillName(skillNameFromTitle(candidate.title))
                  ? undefined
                  : "Enter a name using letters, numbers, spaces, or hyphens.";
                const descriptionError = isValidSkillDescription(candidate.description)
                  ? undefined
                  : "Add a description of up to 1024 characters.";
                const needsDetails = Boolean(nameError || descriptionError || candidate.metadataError);
                return (
                  <LayerCard key={candidate.id} className="overflow-hidden bg-kumo-control p-0">
                    <Collapsible.Root
                      open={candidate.open}
                      onOpenChange={(open) => updateCandidate(candidate.id, { open })}
                    >
                      <Collapsible.Trigger className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-kumo-tint">
                        <ScrollIcon aria-hidden size={18} className="shrink-0 text-kumo-subtle" />
                        <span className="max-w-[40%] shrink-0 truncate text-sm font-medium text-kumo-default">
                          {candidate.title.trim() || candidate.label}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-kumo-subtle">
                          {candidate.description.trim() || "Description needed"}
                        </span>
                        <Badge
                          variant={needsDetails ? "warning" : "success"}
                          appearance="dot"
                          className="shrink-0"
                        >
                          {needsDetails ? "Needs details" : "Ready"}
                        </Badge>
                        <CaretRight
                          aria-hidden
                          size={14}
                          className={`shrink-0 text-kumo-inactive transition-transform ${candidate.open ? "rotate-90" : ""}`}
                        />
                      </Collapsible.Trigger>
                      <Collapsible.Panel className="border-t border-kumo-line px-4 py-4">
                        <div className="flex flex-col gap-3">
                          {candidate.metadataError && (
                            <Text variant="secondary" size="sm">{candidate.metadataError}</Text>
                          )}
                      <Input
                        label="Title"
                        description="Up to 64 letters, numbers, spaces, or hyphens."
                        value={candidate.title}
                        onChange={(event) => updateCandidate(candidate.id, {
                          title: sanitizeSkillTitle(event.target.value),
                          metadataError: null,
                        })}
                        error={nameError}
                        maxLength={64}
                      />
                      <InputArea
                        label="Description"
                        value={candidate.description}
                        onChange={(event) => updateCandidate(candidate.id, {
                          description: event.target.value,
                          metadataError: null,
                        })}
                        error={descriptionError}
                        rows={2}
                        maxLength={1024}
                      />
                        </div>
                      </Collapsible.Panel>
                    </Collapsible.Root>
                  </LayerCard>
                );
              })}
            </div>
          )}

          {failures.length > 0 && (
            <Banner
              variant="error"
              size="sm"
              icon={<WarningCircle weight="fill" />}
              title="Some skills were not fully uploaded"
              description={<span className="whitespace-pre-line">{failures.join("\n")}</span>}
            />
          )}

          {candidates.length === 0 && <div
            className={`flex shrink-0 flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-6 text-center transition-colors ${
              dragging ? "border-kumo-focus bg-kumo-tint" : "border-kumo-line"
            }`}
            onDragEnter={(event) => {
              event.preventDefault();
              if (!reading && !uploading) setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (!reading && !uploading
                && (event.dataTransfer.items.length > 0 || event.dataTransfer.files.length > 0)) {
                const dataTransfer = event.dataTransfer;
                void addFiles(() => readDroppedUploadFiles(dataTransfer));
              }
            }}
          >
            <UploadSimple aria-hidden size={22} className="text-kumo-subtle" />
            <div>
              <Text size="sm" DANGEROUS_className="font-medium">Drop Markdown skills here</Text>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                icon={<FileText size={16} />}
                onClick={() => fileInputRef.current?.click()}
                loading={reading}
                disabled={uploading}
              >
                Choose files
              </Button>
              <Button
                variant="outline"
                size="sm"
                icon={<FolderOpen size={16} />}
                onClick={() => folderInputRef.current?.click()}
                disabled={reading || uploading}
              >
                Choose folder
              </Button>
            </div>
          </div>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
          {finished ? (
            <Button onClick={dialog.requestClose}>Close</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={dialog.requestClose} disabled={reading || uploading}>Cancel</Button>
              <Button
                icon={<UploadSimple size={16} />}
                onClick={upload}
                loading={uploading}
                disabled={!valid || reading}
              >
                Upload {candidates.length > 1 ? `${candidates.length} skills` : "skill"}
              </Button>
            </>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".md,.markdown,text/markdown"
          className="hidden"
          onChange={(event) => {
            if (event.target.files?.length) void chooseFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          // @ts-expect-error non-standard directory upload attribute
          webkitdirectory=""
          className="hidden"
          onChange={(event) => {
            if (event.target.files?.length) void chooseFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </Dialog>
    </Dialog.Root>
  );
};
