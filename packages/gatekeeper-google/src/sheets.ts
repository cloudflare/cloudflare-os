import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { AccessTokenCache, type AccessTokenRequest } from "./auth-retry";
import {
  boundProps, createFileOnce, isSimulated, UNCREATED_FILE_ID, type SimulatedFileProps,
} from "./creation";
import { DriveApi } from "./drive-api";
import { unguardedNativeRead, type NativeRead } from "./drive-session";
import type { GoogleVerifierApi } from "./google-verifier-types";
import { Mutex } from "./mutex";
import { ReadGate } from "./read-gate";
import { nativeFileUrl } from "./resources";
import { batchKind, SHEETS_ACTIONS } from "./sheets-actions";
import {
  BlankSpreadsheet, GoogleSheetsApi, type SheetProtection, type SpreadsheetMetadata,
  type SpreadsheetReader,
} from "./sheets-api";
import { prepareChanges } from "./sheets-input";
import {
  a1Of, cellName, findSheet, intersection, parseRange, type Rect,
} from "./sheets-model";
import { guardDigest, resolveChanges } from "./sheets-plan";
import type {
  GoogleSpreadsheetReadSession, SpreadsheetInfo, SpreadsheetRange, SpreadsheetValueMode,
} from "./sheets-read-types";
import {
  asQueued, buildsOn, conflictReason, overlayRange, replayChanges,
  type Grid, type PlannedChange, type QueuedChange, type SheetBatch, type SheetsAction,
  type SheetsActions,
} from "./sheets-simulation";
import type { GoogleSpreadsheetSession, SheetChange } from "./sheets-types";
import { SHEETS_TYPES_MODULE_PREFIX, stripTypeModulePrefix } from "./type-bundle";
import SHEETS_READ_TYPES_CODE from "./sheets-read-types.txt";
import SHEETS_TYPES_CODE from "./sheets-types.txt";

// A queued change is one Durable Object KV value, which may not exceed 128 KiB serialized.
const MAX_CHANGE_BYTES = 100 * 1024;
// The markers earlier batches left, which the next batch deletes. Outside the journal's
// `sheets:action:` prefix and its counter.
const STALE_MARKERS_KEY = "sheets:staleMarkers";
const MAX_STALE_MARKERS = 20;
// Developer metadata IDs are positive 32-bit integers; 0 asks Google to pick one.
const MAX_MARKER_ID = 2 ** 31 - 1;

type Env = Cloudflare.Env;

// Throws if `value` would not fit in the one storage value a queued change is.
function checkQueuedSize(value: unknown): void {
  // Storage serializes a string holding any non-Latin-1 character at two bytes a unit.
  let bytes = JSON.stringify(value).length * 2;
  if (bytes > MAX_CHANGE_BYTES) {
    throw new Error(`This change is too large to queue (${bytes} bytes, limit ` +
      `${MAX_CHANGE_BYTES}). Split it up.`);
  }
}

let sheetsTypesCode: string | undefined;

/** The agent declarations for a directly bound spreadsheet. */
export function getGoogleSheetsTypesCode(): string {
  return sheetsTypesCode ??= [
    SHEETS_READ_TYPES_CODE,
    stripTypeModulePrefix(SHEETS_TYPES_CODE, SHEETS_TYPES_MODULE_PREFIX),
  ].join("\n");
}

/** What a spreadsheet binding names: its owner's account and the one spreadsheet. */
export type GoogleSheetsGatekeeperImplProps =
  { userObjectId: string; spreadsheetId: string } | SimulatedFileProps;

/** What a session needs of its gatekeeper to show and queue changes. */
export type SheetsChangeQueue = {
  /**
   * Runs `read` with the changes awaiting a decision, oldest first, while none is being applied
   * or rejected. A change Google commits mid-read would otherwise show twice: once in what Google
   * returns, and again replayed on top. Nor is a claimed change, which cannot be mid-apply here: an
   * activation died applying it, so whether Google has it is unknown.
   */
  snapshot<T>(read: (pending: readonly QueuedChange[]) => Promise<T>): Promise<T>;
  /**
   * Runs `prepare` while no other change is being prepared, then queues the change it returns for
   * approval. A change is checked against the simulation it extends, so two at once could each
   * pass against a state the other invalidates.
   */
  queue<K extends keyof SheetsActions, T>(
    kind: K, prepare: () => Promise<{ payload: SheetsActions[K]; result: T }>,
  ): Promise<T>;
  /** Whether the connected account may edit the spreadsheet, as Drive reports it. */
  editable(): Promise<boolean>;
};

/** The queue of a session nothing can be queued against: its reads see no pending change. */
export const NO_CHANGES: SheetsChangeQueue = {
  snapshot: read => read([]),
  queue: () => Promise.reject(new Error("This Google spreadsheet is open read-only.")),
  editable: () => Promise.resolve(false),
};

/** The queue of a spreadsheet not created yet: it reads as created, but takes no change before. */
const NOT_CREATED: SheetsChangeQueue = {
  ...NO_CHANGES,
  queue: () => Promise.reject(new Error(
    "This Google spreadsheet is not created yet, so no change to it can be queued. Once its " +
    "creation is approved, change it from a new session.")),
};

/** The gatekeeper for one directly bound spreadsheet. */
@validateRpc()
export class GoogleSheetsGatekeeperImpl
    extends DurableObject<Env, GoogleSheetsGatekeeperImplProps>
    implements Gatekeeper<GoogleSpreadsheetSession> {
  #creating = new Mutex();
  #tokens = new AccessTokenCache(opts => {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.#bound.userObjectId),
    );
    return account.getAccessToken(opts);
  });
  #spreadsheetId = isSimulated(this.ctx.props) ? UNCREATED_FILE_ID : this.ctx.props.spreadsheetId;

  #api = new GoogleSheetsApi((opts?: AccessTokenRequest) => this.#tokens.get(opts));
  #drive = new DriveApi((opts?: AccessTokenRequest) => this.#tokens.get(opts));
  #journal = new ActionJournal<SheetsAction>(this.ctx.storage.kv, { namespace: "sheets" });
  #actions = SHEETS_ACTIONS.bind(this.#journal, {
    api: this.#api,
    spreadsheetId: this.#spreadsheetId,
    applied: id => this.#journal.get(id)?.state === "applied" || this.#journal.wasApplied(id),
    markers: {
      read: () => this.ctx.storage.kv.get<number[]>(STALE_MARKERS_KEY) ?? [],
      write: ids => this.ctx.storage.kv.put(STALE_MARKERS_KEY, ids.slice(-MAX_STALE_MARKERS)),
    },
  });
  #reads = new ReadGate();
  #preparing = new SerialTaskQueue();
  #inPreparation = 0;

  /** The account and spreadsheet this binding reaches, which a spreadsheet not yet created has not. */
  get #bound(): { userObjectId: string; spreadsheetId: string } {
    return boundProps(this.ctx.props, "sheets");
  }

  async describe(): Promise<ResourceDescription> {
    let props = this.ctx.props;
    if (isSimulated(props)) {
      let { title } = props.creation;
      return {
        url: nativeFileUrl("sheets"),
        title,
        snippet: `Google Spreadsheet: ${title} (read-only; not created yet)`,
        suggestedBindingName: "GOOGLE_SHEET",
        tsType: "GoogleSpreadsheetSession",
      };
    }
    let spreadsheet = await this.#api.getSpreadsheet(props.spreadsheetId);
    return {
      url: nativeFileUrl("sheets", props.spreadsheetId),
      title: spreadsheet.title,
      snippet: `Google Spreadsheet: ${spreadsheet.title}`,
      suggestedBindingName: "GOOGLE_SHEET",
      tsType: "GoogleSpreadsheetSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return getGoogleSheetsTypesCode();
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#actions.autoApprovableKinds();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GoogleSpreadsheetSession> {
    let props = this.ctx.props;
    let queue = approvalQueue.dup();
    let read = unguardedNativeRead(description => queue.authorizeObservation(description));
    if (isSimulated(props)) {
      return new GoogleSpreadsheetSessionImpl(
        this.#api, UNCREATED_FILE_ID, queue, read, NOT_CREATED, new BlankSpreadsheet(props.creation.title));
    }
    // A spreadsheet binding's scope is the one spreadsheet, so there is nothing to revalidate.
    return new GoogleSpreadsheetSessionImpl(
      this.#api, props.spreadsheetId, queue, read,
      {
        snapshot: read => this.#reads.read(() => read(this.#journal.listUndecided())),
        queue: (kind, prepare) => this.#prepareExclusively(async () => {
          let { payload, result } = await prepare();
          checkQueuedSize(payload);
          await this.#actions.submit(queue, kind, payload);
          return result;
        }),
        editable: () => this.#drive.canEdit(props.spreadsheetId),
      },
    );
  }

  async applyCreation(creator: Fetcher<GatekeeperUserVerifier>)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, resourceUrl: string}> {
    return this.#creating.run(async () => {
      let { userObjectId, fileId, resourceUrl } = await createFileOnce(this.ctx, creator, "sheets",
          (title, tokens) => new GoogleSheetsApi(tokens).createSpreadsheet(title));
      return {
        class: this.ctx.exports.GoogleSheetsGatekeeperImpl({props: {userObjectId, spreadsheetId: fileId}}),
        resourceUrl,
      };
    });
  }

  #prepareExclusively<T>(body: () => Promise<T>): Promise<T> {
    this.#inPreparation++;
    return this.#preparing.run(body).finally(() => this.#inPreparation--);
  }

  applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    return this.#reads.resolve(async () => {
      // Each change was checked against those queued before it, so they apply in that order. A
      // decided or failed change is left to the action set, which answers it without a write.
      let state = this.#journal.get(actionId)?.state;
      let earlier = (state === "staged" || state === "pending") &&
        this.#journal.listPending().find(({ id }) => id < actionId);
      if (earlier) {
        throw new Error(
          `Google Sheets changes apply in the order they were queued. Approve or reject change ` +
          `${earlier.id} first.`);
      }
      await this.#actions.apply(actionId);
    });
  }

  rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    return this.#reads.resolve(async () => {
      let pending = this.#journal.listPending();
      let shown = pending.some(({ id }) => id === actionId);
      // Changes queued or being prepared after it were checked against it, and the gadget has
      // read them on top of it.
      let builtOn = pending.at(-1)?.id !== actionId || this.#inPreparation > 0;
      await this.#actions.reject(actionId);
      if (shown && builtOn) return { restart: true };
    });
  }

  revertAction(_action: number): Promise<void> {
    throw new Error("Google Sheets changes cannot be reverted automatically.");
  }

  /**
   * Observer tracking — strategy B (ACL check, single unit). Google applies sharing permissions at
   * spreadsheet granularity, so an observer must be able to open this spreadsheet with their own
   * account. The overseer re-runs this check on every open, catching revoked access.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasSpreadsheetAccess(this.#bound.spreadsheetId))) {
      throw new Error(
        "This collaborator does not have access to the bound Google spreadsheet, so they cannot " +
        "observe data this workspace read from it.",
      );
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}

/** A read with queued changes applied, and the first that no longer applies. */
function replayed(base: Grid, changes: readonly QueuedChange[]): { grid: Grid; conflict?: string } {
  let result = replayChanges(base, changes);
  return result.kind === "complete"
    ? { grid: result.value }
    : { grid: result.partial, conflict: conflictReason(result.unsupported, result.reason) };
}

function gridOf(metadata: SpreadsheetMetadata): Grid {
  return { sheets: metadata.sheets, cells: new Map() };
}

function within({ startRow, endRow, startColumn, endColumn }: Rect, row: number, column: number): boolean {
  return row >= startRow && row < endRow && column >= startColumn && column < endColumn;
}

// The protected range's cells by name, where its ends are bounded.
function protectionName(protection: SheetProtection, title: string): string {
  let { rect } = protection.area;
  if ([rect.endRow, rect.endColumn].every(Number.isFinite)) return `the protected range ${a1Of(title, rect)}`;
  return `a protected range of "${title}"`;
}

/**
 * Refuses a change writing a cell of a protected range the connected account may not edit, and
 * that the range does not leave editable.
 */
function checkProtections(
  changes: readonly PlannedChange[], protections: readonly SheetProtection[], grid: Grid,
): void {
  changes.forEach((change, i) => {
    for (let protection of protections) {
      if (protection.requestingUserCanEdit || protection.area.sheetId !== change.sheetId) continue;
      let shared = intersection(change.rect, protection.area.rect);
      if (!shared) continue;
      for (let row = shared.startRow; row < shared.endRow; row++) {
        for (let column = shared.startColumn; column < shared.endColumn; column++) {
          let editable = protection.unprotected.some(({ sheetId, rect }) =>
            sheetId === change.sheetId && within(rect, row, column));
          if (editable) continue;
          let title = grid.sheets.find(sheet => sheet.id === change.sheetId)?.title ?? "";
          throw new Error(`Change ${i + 1} (${change.op}): ${cellName(row, column)} is in ` +
            `${protectionName(protection, title)}, which the connected account may not edit.`);
        }
      }
    }
  });
}

/** What `updateSheet()` read to queue a batch, or why it cannot queue one. */
type Prepared = {
  title: string;
  editable: boolean;
  conflict?: string;
  refusal?: Error;
  batch?: Omit<SheetBatch, "marker">;
};

/** A directly bound spreadsheet's session, exported for tests. */
@validateRpc()
export class GoogleSpreadsheetSessionImpl extends RpcTarget implements GoogleSpreadsheetSession {
  #api: GoogleSheetsApi;
  #reader: SpreadsheetReader;
  #spreadsheetId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #read: NativeRead;
  #changes: SheetsChangeQueue;

  /** `reader` makes the reads with nothing queued: for a spreadsheet not created yet, a blank one. */
  constructor(
    api: GoogleSheetsApi,
    spreadsheetId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    read: NativeRead,
    changes: SheetsChangeQueue,
    reader: SpreadsheetReader = api,
  ) {
    super();
    this.#api = api;
    this.#reader = reader;
    this.#spreadsheetId = spreadsheetId;
    this.#approvalQueue = approvalQueue;
    this.#read = read;
    this.#changes = changes;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getSpreadsheet(): Promise<SpreadsheetInfo> {
    return this.#read(
      () => this.#changes.snapshot(async pending => {
        if (pending.length === 0) return this.#reader.getSpreadsheet(this.#spreadsheetId);
        let metadata = await this.#api.getMetadata(this.#spreadsheetId);
        let { grid, conflict } = replayed(gridOf(metadata), pending);
        return {
          id: metadata.id,
          title: metadata.title,
          ...(metadata.locale ? { locale: metadata.locale } : {}),
          ...(metadata.timeZone ? { timeZone: metadata.timeZone } : {}),
          sheets: grid.sheets.map(({ id, title, index, rowCount, columnCount, hidden }) =>
            ({ id, title, index, rowCount, columnCount, ...(hidden ? { hidden } : {}) })),
          ...(conflict ? { queuedChangeConflict: conflict } : {}),
        };
      }),
      spreadsheet => ({
        title: "Read Google spreadsheet metadata",
        description:
          `Read metadata for "${spreadsheet.title}", including its ${spreadsheet.sheets.length} ` +
          "worksheet(s).",
      }));
  }

  async readRange(
    range: string,
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange> {
    return (await this.#readRanges([range], options))[0];
  }

  async readRanges(
    ranges: string[],
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange[]> {
    return this.#readRanges(ranges, options);
  }

  /** `ranges` as Google returns them, showing what queued changes enter in their cells. */
  async #simulatedRanges(
    ranges: string[], pending: readonly QueuedChange[], mode: SpreadsheetValueMode | undefined,
  ): Promise<SpreadsheetRange[]> {
    if (pending.length === 0) return this.#reader.readRanges(this.#spreadsheetId, ranges, mode);
    // A malformed range is refused before anything is fetched.
    let parsed = ranges.map(range => parseRange(range));
    let [metadata, read] = await Promise.all([
      this.#api.getMetadata(this.#spreadsheetId),
      this.#api.readRanges(this.#spreadsheetId, ranges, mode),
    ]);
    let { grid, conflict } = replayed(gridOf(metadata), pending);
    return read.map((range, i) => {
      // Google reads a range naming no sheet from the first visible one.
      let sheet = findSheet(grid.sheets, parsed[i].sheet);
      let shown = sheet ? overlayRange(range, sheet.id, parsed[i].rect, grid, mode) : range;
      return conflict ? { ...shown, queuedChangeConflict: conflict } : shown;
    });
  }

  async #readRanges(
    ranges: string[],
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange[]> {
    return this.#read(
      () => this.#changes.snapshot(pending => this.#simulatedRanges(ranges, pending, options?.valueMode)),
      result => {
        let cellCount = result.reduce(
          (total, range) => total + range.values.reduce((sum, row) => sum + row.length, 0),
          0,
        );
        return {
          title: result.length === 1
            ? `Read Google Sheets range ${result[0].range}`
            : `Read ${result.length} Google Sheets ranges`,
          description:
            `Read ${cellCount.toLocaleString()} cell(s) from ${result.length} bounded range(s) ` +
            "in the connected spreadsheet.",
        };
      });
  }

  async updateSheet(changes: SheetChange[]): Promise<Record<string, number>> {
    let prepared = prepareChanges(changes);
    // The queued batch holds every value, so one that cannot be stored is refused before any read.
    checkQueuedSize(prepared);
    return this.#changes.queue(batchKind(prepared), async () => {
      let read = await this.#read(
        () => this.#changes.snapshot(async (pending): Promise<Prepared> => {
          let [metadata, editable] = await Promise.all([
            this.#api.getMetadata(this.#spreadsheetId), this.#changes.editable(),
          ]);
          let { grid, conflict } = replayed(gridOf(metadata), pending);
          if (!editable || conflict) return { title: metadata.title, editable, conflict };
          let planned: PlannedChange[];
          try {
            planned = resolveChanges(grid, prepared);
            checkProtections(planned, metadata.protectedRanges, grid);
          } catch (error) {
            // Reported after authorization, since it reveals the spreadsheet's sheets.
            return { title: metadata.title, editable, refusal: error as Error };
          }
          // What the batch overwrites as it is to be when the batch applies: as Google holds it
          // now, with what changes queued before it enter.
          let entered = await this.#api.readEntered(
            this.#spreadsheetId, planned.map(({ sheetId, rect }) => ({ sheetId, rect })));
          let sha256 = await guardDigest(grid.sheets, planned, asQueued(grid, planned, entered));
          let sheets = Object.fromEntries(planned.map(({ sheetId }) =>
            [sheetId, grid.sheets.find(sheet => sheet.id === sheetId)!.title]));
          let guard = { sha256, after: buildsOn(pending, planned) };
          return { title: metadata.title, editable, batch: { changes: planned, sheets, guard } };
        }),
        ({ title }) => ({
          title: "Read Google Sheets cells to change them",
          description: `Read the cells ${prepared.length} change(s) write in "${title}" to queue them.`,
        }));
      if (!read.editable) {
        throw new Error(
          `The connected Google account can view "${read.title}" but not edit it, so no change to ` +
          "it can be queued.");
      }
      if (read.conflict) {
        throw new Error(`${read.conflict} No more changes can be queued until it is rejected.`);
      }
      if (read.refusal) throw read.refusal;
      // Minted here, so every attempt to apply the batch carries the same marker.
      let marker = {
        id: crypto.getRandomValues(new Uint32Array(1))[0] % MAX_MARKER_ID + 1,
        token: crypto.randomUUID(),
      };
      return { payload: { ...read.batch!, marker }, result: {} };
    });
  }
}

/**
 * A spreadsheet opened read-only, as Drive opens one. It holds the read/write session rather than
 * extending it, so its RPC surface has no write method to call: the reads are the same code, run
 * against no queued changes.
 */
@validateRpc()
export class GoogleSpreadsheetReadSessionImpl extends RpcTarget
    implements GoogleSpreadsheetReadSession {
  #session: GoogleSpreadsheetSessionImpl;

  constructor(
    api: GoogleSheetsApi,
    spreadsheetId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    read: NativeRead,
  ) {
    super();
    this.#session = new GoogleSpreadsheetSessionImpl(
      api, spreadsheetId, approvalQueue, read, NO_CHANGES);
  }

  [Symbol.dispose](): void {
    this.#session[Symbol.dispose]();
  }

  getSpreadsheet(): Promise<SpreadsheetInfo> {
    return this.#session.getSpreadsheet();
  }

  readRange(
    range: string, options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange> {
    return this.#session.readRange(range, options);
  }

  readRanges(
    ranges: string[], options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange[]> {
    return this.#session.readRanges(ranges, options);
  }
}
