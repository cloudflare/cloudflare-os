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
  BlankSpreadsheet, GoogleSheetsApi, parseFormatRange, validateRanges, type SheetArea,
  type SpreadsheetMetadata, type SpreadsheetReader,
} from "./sheets-api";
import type { BaseFormats } from "./sheets-format";
import { isRangeChange, prepareChanges } from "./sheets-input";
import { findSheet, parseRange, type Rect } from "./sheets-model";
import {
  checkProtections, guardAfter, guardCells, guardDigest, guardedSheets, resolveChanges, sheetLabels,
} from "./sheets-plan";
import type {
  GoogleSpreadsheetReadSession, SpreadsheetFormats, SpreadsheetInfo, SpreadsheetRange,
  SpreadsheetValueMode,
} from "./sheets-read-types";
import {
  basePiecesOf, baseValues, conflictReason, enteredContent, gridOf, overlayRange, rangesToFetch,
  replayChanges, resolveArea, simulatedFormats, simulatedRange, type Grid, type PlannedChange,
  type QueuedChange, type SheetBatch, type SheetsAction, type SheetsActions, type SimulatedArea,
} from "./sheets-simulation";
import type { GoogleSpreadsheetSession, SheetChange } from "./sheets-types";
import { SHEETS_TYPES_MODULE_PREFIX, stripTypeModulePrefix } from "./type-bundle";
import SHEETS_READ_TYPES_CODE from "./sheets-read-types.txt";
import SHEETS_TYPES_CODE from "./sheets-types.txt";

// A queued change is one Durable Object KV value, which may not exceed 128 KiB serialized.
const MAX_CHANGE_BYTES = 100 * 1024;
// A format read's result, in UTF-16 units of its JSON: Google's own answer is capped at 5 MiB.
const MAX_FORMATS_READ_LENGTH = 5 * 1024 * 1024;
// The markers earlier batches left, which the next batch deletes. Outside the journal's
// `sheets:action:` prefix and its counter.
const STALE_MARKERS_KEY = "sheets:staleMarkers";
const MAX_STALE_MARKERS = 20;
// Developer metadata IDs are positive 32-bit integers; 0 asks Google to pick one. Sheet IDs are
// non-negative 32-bit integers.
const MAX_MARKER_ID = 2 ** 31 - 1;

type Env = Cloudflare.Env;

// A random ID for a marker or a sheet a change adds: from 1 to `MAX_MARKER_ID`.
function randomId(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] % MAX_MARKER_ID + 1;
}

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

/**
 * `read`, Google's values for each of `ranges`, showing what queued changes enter in their cells,
 * for a grid whose queued changes leave rows, columns and sheets where they are.
 */
function overlaid(
  read: readonly SpreadsheetRange[], ranges: readonly { sheet?: string; rect: Rect }[], grid: Grid,
  mode: SpreadsheetValueMode | undefined,
): SpreadsheetRange[] {
  return read.map((range, i) => {
    // Google reads a range naming no sheet from the first visible one.
    let sheet = findSheet(grid.sheets, ranges[i].sheet);
    return sheet ? overlayRange(range, sheet.id, ranges[i].rect, grid, mode) : range;
  });
}

/** Whether any of `pending` might move rows, columns or sheets, as only changes to ranges cannot. */
function mayMoveCells(pending: readonly QueuedChange[]): boolean {
  return pending.some(({ action }) => action.payload.changes.some(change => !isRangeChange(change)));
}

/**
 * `read`, Google's formats for `rect` of sheet `sheetId` padded to its size, by cell of the
 * spreadsheet Google holds.
 */
function formatsOf(read: SpreadsheetFormats, sheetId: number, rect: Rect): BaseFormats {
  return (sheet, row, column) => sheet === sheetId
    ? read.formats[row - rect.startRow]?.[column - rect.startColumn] ?? null
    : null;
}

/** A read refused for what it found, which is reported only once the read is authorized. */
class RefusedRead extends Error {
  constructor(readonly refusal: Error) {
    super(refusal.message);
  }
}

/** What `updateSheet()` read to queue a batch, or why it cannot queue one. */
type Prepared = {
  title: string;
  editable: boolean;
  conflict?: string;
  refusal?: Error;
  batch?: Omit<SheetBatch, "marker">;
  refs?: Record<string, number>;
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

  /**
   * `ranges` as Google returns them, showing what queued changes enter in their cells, and, once
   * queued changes move rows, columns or sheets, as those changes leave them.
   */
  async #simulatedRanges(
    ranges: string[], pending: readonly QueuedChange[], mode: SpreadsheetValueMode | undefined,
  ): Promise<SpreadsheetRange[]> {
    if (pending.length === 0) return this.#reader.readRanges(this.#spreadsheetId, ranges, mode);
    // A malformed range is refused before anything is fetched.
    let parsed = ranges.map(range => parseRange(range));
    let shown: SpreadsheetRange[];
    let conflict: string | undefined;
    if (mayMoveCells(pending)) {
      validateRanges(ranges);
      let replay = replayed(gridOf(await this.#api.getMetadata(this.#spreadsheetId)), pending);
      conflict = replay.conflict;
      shown = replay.grid.log.length > 0
        ? await this.#movedRanges(replay.grid, parsed, mode ?? "formatted")
        : overlaid(await this.#api.readRanges(this.#spreadsheetId, ranges, mode), parsed, replay.grid, mode);
    } else {
      let [metadata, read] = await Promise.all([
        this.#api.getMetadata(this.#spreadsheetId),
        this.#api.readRanges(this.#spreadsheetId, ranges, mode),
      ]);
      let replay = replayed(gridOf(metadata), pending);
      conflict = replay.conflict;
      shown = overlaid(read, parsed, replay.grid, mode);
    }
    return conflict ? shown.map(range => ({ ...range, queuedChangeConflict: conflict })) : shown;
  }

  /**
   * `ranges` of `grid`, whose queued changes move rows, columns or sheets, read from the cells of
   * the spreadsheet Google holds they show: in `mode`, and in formula mode to tell its formulas.
   * Those cells are fetched by grid range, since a range's title or bounds may name nothing
   * Google holds.
   */
  async #movedRanges(
    grid: Grid, ranges: readonly { sheet?: string; rect: Rect }[], mode: SpreadsheetValueMode,
  ): Promise<SpreadsheetRange[]> {
    let areas: ReturnType<typeof resolveArea>[];
    let pieces: ReturnType<typeof rangesToFetch>;
    try {
      areas = ranges.map(range => resolveArea(grid, range));
      pieces = rangesToFetch(grid, areas);
    } catch (error) {
      // These name the spreadsheet's sheets and sizes, so they wait for the read's authorization.
      throw new RefusedRead(error as Error);
    }
    let [shown, formulas] = await Promise.all([
      this.#api.readAreas(this.#spreadsheetId, pieces, mode),
      mode === "formula" ? undefined : this.#api.readAreas(this.#spreadsheetId, pieces, "formula"),
    ]);
    let shownValues = baseValues(pieces, shown);
    let base = { shown: shownValues, formulas: formulas ? baseValues(pieces, formulas) : shownValues };
    return areas.map(area => simulatedRange(grid, area, base, mode));
  }

  async #readRanges(
    ranges: string[],
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange[]> {
    let read = await this.#read(
      () => this.#changes.snapshot(pending => this.#simulatedRanges(ranges, pending, options?.valueMode))
        .catch((error: unknown) => {
          if (error instanceof RefusedRead) return error;
          throw error;
        }),
      result => {
        if (result instanceof RefusedRead) {
          return {
            title: "Read Google Sheets ranges",
            description: `Looked up ${ranges.length} range(s) in the connected spreadsheet with the ` +
              "queued changes applied.",
          };
        }
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
    if (read instanceof RefusedRead) throw read.refusal;
    return read;
  }

  async readFormats(range: string): Promise<SpreadsheetFormats> {
    let read = await this.#read(
      () => this.#changes.snapshot(pending => this.#simulatedFormats(range, pending))
        .catch((error: unknown) => {
          if (error instanceof RefusedRead) return error;
          throw error;
        }),
      result => {
        if (result instanceof RefusedRead) {
          return {
            title: "Read Google Sheets formatting",
            description: "Looked up a range in the connected spreadsheet with the queued changes " +
              "applied.",
          };
        }
        let cellCount = result.formats.reduce((sum, row) => sum + row.length, 0);
        return {
          title: `Read Google Sheets formatting of ${result.range}`,
          description: `Read the formatting of ${cellCount.toLocaleString()} cell(s) in the ` +
            "connected spreadsheet.",
        };
      });
    if (read instanceof RefusedRead) throw read.refusal;
    // Queued formatting is repeated across every cell it covers, so the result can outgrow what
    // Google returned.
    if (JSON.stringify(read).length > MAX_FORMATS_READ_LENGTH) {
      throw new Error("The formatting of this range is too large to read at once. Request fewer cells.");
    }
    return read;
  }

  /**
   * The formatting of `range` as Google holds it, and, once queued changes move rows, columns or
   * sheets, as those changes leave it.
   */
  async #simulatedFormats(
    range: string, pending: readonly QueuedChange[],
  ): Promise<SpreadsheetFormats> {
    if (pending.length === 0) return this.#reader.readFormats(this.#spreadsheetId, range);
    // A malformed range is refused before anything is fetched.
    let parsed = parseFormatRange(range);
    let metadata: SpreadsheetMetadata;
    let read: SpreadsheetFormats | undefined;
    if (mayMoveCells(pending)) {
      metadata = await this.#api.getMetadata(this.#spreadsheetId);
    } else {
      [metadata, read] = await Promise.all([
        this.#api.getMetadata(this.#spreadsheetId),
        this.#api.readFormats(this.#spreadsheetId, range),
      ]);
    }
    let { grid, conflict } = replayed(gridOf(metadata), pending);
    let area: SimulatedArea;
    let pieces: SheetArea[];
    try {
      area = resolveArea(grid, parsed);
      pieces = grid.log.length > 0 ? rangesToFetch(grid, [area]) : [];
    } catch (error) {
      // These name the spreadsheet's sheets and sizes, so they wait for the read's authorization.
      throw new RefusedRead(error as Error);
    }
    // With no row, column or sheet moved, every cell is where Google holds it, so the range is
    // read as named. Otherwise the cells it shows are read by grid range, since its title or
    // bounds may name nothing Google holds.
    let base = grid.log.length > 0
      ? await this.#api.readFormatAreas(this.#spreadsheetId, pieces)
      : formatsOf(read ?? await this.#api.readFormats(this.#spreadsheetId, range), area.sheetId, parsed.rect);
    let shown = simulatedFormats(grid, area, base);
    return conflict ? { ...shown, queuedChangeConflict: conflict } : shown;
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
          let refs: Record<string, number>;
          let cells: SheetArea[];
          try {
            ({ planned, refs } = resolveChanges(grid, prepared, randomId));
            checkProtections(metadata, grid, planned);
            cells = guardCells(grid, planned);
          } catch (error) {
            // Reported after authorization, since it reveals the spreadsheet's sheets.
            return { title: metadata.title, editable, refusal: error as Error };
          }
          // What the batch overwrites or removes as it is to be when the batch applies: as Google
          // holds it now, with the changes queued before it made.
          let pieces = basePiecesOf(grid, cells);
          let entered = await this.#api.readAreas(this.#spreadsheetId, pieces, "formula");
          let sha256 = await guardDigest(
            grid.sheets, { sheetIds: guardedSheets(planned), cells },
            enteredContent(grid, cells, baseValues(pieces, entered)));
          let guard = { sha256, after: guardAfter(grid, pending, planned, cells), cells };
          return {
            title: metadata.title, editable, refs,
            batch: { changes: planned, sheets: sheetLabels(grid, planned), guard },
          };
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
      let marker = { id: randomId(), token: crypto.randomUUID() };
      return { payload: { ...read.batch!, marker }, result: read.refs! };
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

  readFormats(range: string): Promise<SpreadsheetFormats> {
    return this.#session.readFormats(range);
  }
}
