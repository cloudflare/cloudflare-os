import { describe, expect, it } from "vitest";
import { OffsetCursor, TokenCursor } from "../../src/cursors";
import { createSimulationView, ProvisionalIds, type SimulationRecord } from "../../src/simulation";
import { createSimulationStore, simulatedList, type EntityStep } from "../../src/simulation-store";
import { fakeKv } from "../fake-kv";

// Two listings, each written as a gatekeeper writes one, walked through a real kit cursor over a
// fake provider: incidents by offset, as `packages/gatekeeper-pagerduty` lists them, and mail by
// token, as `packages/gatekeeper-microsoft` does. The filter, the order, the rows read again and
// where they are placed are each fixture's own: `simulatedList` is given `keeps` and `compare`
// and makes the stand-ins, the per-row fold and the hidden rows.

/** A time `minute` minutes into the hour the fixtures share, as providers stamp rows. */
const at = (minute: number): string => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

const isProvisional = (id: string): boolean => id.startsWith("~");

/** A provider id: a prefix and a number of two digits. */
const numbered = (prefix: string, n: number): string => `${prefix}${String(n).padStart(2, "0")}`;

/** Every page of a walk, to its end. */
async function drain<T>(cursor: { next(): Promise<T[] | null> }): Promise<T[][]> {
  const pages: T[][] = [];
  for (let page = await cursor.next(); page !== null; page = await cursor.next()) pages.push(page);
  return pages;
}

const idsOf = (page: readonly { id: string }[] | null): string[] | undefined =>
  page?.map(({ id }) => id);

/** `items` in pages of `size`, as a provider with nothing pending serves them. */
const pagesOf = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, page) =>
    items.slice(page * size, (page + 1) * size));

describe("an incident listing over an OffsetCursor", () => {
  type Status = "triggered" | "acknowledged" | "resolved";
  type Incident = {
    readonly id: string;
    readonly status: Status;
    readonly urgency: "high" | "low";
    readonly assignees: readonly string[];
    readonly serviceId: string;
    readonly createdAt: string;
  };
  type NewIncident = {
    readonly ref: string;
    readonly serviceId: string;
    readonly assignTo?: readonly string[];
    readonly stagedAt: string;
  };
  type IncidentAction =
    | ({ kind: "createIncident" } & NewIncident)
    | { kind: "acknowledge" | "resolve"; incident: { id: string } }
    | { kind: "reassign"; incident: { id: string }; to: readonly string[] };
  type Staged = SimulationRecord<IncidentAction>;

  const ME = "me";
  const newestFirst = (a: Incident, b: Incident): number =>
    Date.parse(b.createdAt) - Date.parse(a.createdAt);

  /**
   * A provider of thirty incidents, P01 the newest, two minutes apart, with a journal of staged
   * actions and the temporary ids of the incidents they open. P04 is triggered and P09 resolved;
   * the rest are acknowledged. Every fifth is on the second service.
   */
  function incidentProvider() {
    const ids = new ProvisionalIds<string>(fakeKv(), { namespace: "incident:", isProvisional });
    const incidents: Incident[] = Array.from({ length: 30 }, (_, index) => {
      const n = index + 1;
      return {
        id: numbered("P", n),
        status: n === 4 ? "triggered" : n === 9 ? "resolved" : "acknowledged",
        urgency: "high",
        assignees: ["ann"],
        serviceId: n % 5 === 0 ? "svc-b" : "svc-a",
        createdAt: at(100 - 2 * n),
      };
    });
    const journal: Staged[] = [];
    let sequence = 1;
    const stage = (action: IncidentAction): number => {
      journal.push({ id: sequence, action });
      return sequence++;
    };
    const hooks: { fetching?: () => void } = {};
    return {
      ids,
      incidents,
      /** The services the capability reaches; a test takes one away mid-walk. */
      services: new Set(["svc-a", "svc-b"]),
      hooks,
      stage,
      /** Stages the opening of an incident, staged at `minute`, under a fresh temporary id. */
      open: (minute: number, fields: Partial<NewIncident> = {}): string => {
        const ref = ids.allocate(n => `~${n}`);
        stage({ kind: "createIncident", ref, serviceId: "svc-a", stagedAt: at(minute), ...fields });
        return ref;
      },
      /** Removes a staged action, as a journal does once it applied or was rejected. */
      settle: (id: number): void => void journal.splice(journal.findIndex(e => e.id === id), 1),
      pending: (): readonly Staged[] => [...journal],
      /** The provider's incident listing: filtered by status before anything pending applies. */
      list: async (statuses: readonly Status[], offset: number, limit: number) => {
        hooks.fetching?.();
        return incidents
          .filter(({ status }) => statuses.includes(status))
          .toSorted(newestFirst)
          .slice(offset, offset + limit);
      },
      read: (id: string): Incident | undefined => incidents.find(incident => incident.id === id),
    };
  }
  type IncidentProvider = ReturnType<typeof incidentProvider>;

  /** An incident a pending action opens: acknowledged if assigned to the caller alone. */
  const pendingSummary = (payload: NewIncident, me: string): Incident => ({
    id: payload.ref,
    status: payload.assignTo?.length === 1 && payload.assignTo[0] === me
      ? "acknowledged" : "triggered",
    urgency: "high",
    assignees: payload.assignTo ?? [],
    serviceId: payload.serviceId,
    createdAt: payload.stagedAt,
  });

  /** The incidents the provider has that a pending action may move into a status filter. */
  const changedIncidents = (pending: readonly Staged[], resolve: (id: string) => string) =>
    [...new Set(pending.flatMap(({ action }) =>
      action.kind === "createIncident" ? [] : [resolve(action.incident.id)]))]
      .filter(id => !isProvisional(id));

  /** Incidents in `statuses`, newest first, as pending actions leave them. */
  function listIncidents(
    host: IncidentProvider,
    statuses: readonly Status[],
    { pageSize = 4, remotePageSize = 12 } = {},
  ) {
    const me = ME;
    const resolve = (id: string): string => host.ids.resolve(id);
    // A create targets its temporary id until the provider's takes its place, and nothing after.
    const targets = (action: IncidentAction): readonly string[] =>
      action.kind === "createIncident"
        ? resolve(action.ref) === action.ref ? [action.ref] : []
        : [resolve(action.incident.id)];
    const store = createSimulationStore<string, Incident, Incident, Staged>({
      initial: row => row,
      reduce: (incident, { action }): EntityStep<Incident> => {
        const none = { kind: "known-no-effect" } as const;
        const applied = (value: Incident) => ({ kind: "applied", value }) as const;
        switch (action.kind) {
          case "createIncident":
            // Whatever it is given: `targets` is what keeps a bound create off the provider's row.
            return applied(pendingSummary(action, me));
          case "acknowledge": {
            // A resolved incident stays as it is; any other goes to whoever acknowledges it.
            if (incident === undefined || incident.status === "resolved") return none;
            const mine = incident.assignees.includes(me);
            if (mine && incident.status === "acknowledged") return none;
            return applied({
              ...incident,
              status: "acknowledged",
              assignees: mine ? incident.assignees : [me],
            });
          }
          case "resolve":
            return incident === undefined || incident.status === "resolved"
              ? none
              : applied({ ...incident, status: "resolved", assignees: [] });
          case "reassign":
            return incident === undefined ? none : applied({ ...incident, assignees: action.to });
        }
      },
    });

    // The provider filters before pending changes apply, so it leaves out an incident they move
    // into the filter: each incident they act on is read afresh, and listed if they leave it
    // matching.
    const changed = new Map(changedIncidents(host.pending(), resolve).flatMap(id => {
      const read = host.read(id);
      return read ? [[id, read] as const] : [];
    }));
    // The capability's services and the pending actions as of the page being served.
    let live = new Set(host.services);
    let pending = host.pending();
    const keeps = (row: Incident): boolean =>
      live.has(row.serviceId) && statuses.includes(row.status);
    const list = simulatedList({
      store,
      // Built on each call: an id resolves when a row is served, not when the page was asked for.
      view: () => createSimulationView(pending, targets),
      id: row => row.id,
      compare: newestFirst,
      keeps,
      // The journal as it is now: a create settled before its stand-in is admitted drops it.
      created: () => host.pending().flatMap(({ action }) =>
        action.kind === "createIncident" && resolve(action.ref) === action.ref ? [action.ref] : []),
    });
    const authorized: string[][] = [];
    const cursor = new OffsetCursor<Incident>({
      pageSize,
      remotePageSize,
      fetchPage: (offset, limit) => host.list(statuses, offset, limit),
      refresh: async () => {
        live = new Set(host.services);
        pending = host.pending();
        list.refresh();
      },
      overlay: list.overlay,
      inject: {
        items: [...list.inject.items, ...[...changed.values()].flatMap(list.overlay)]
          .toSorted(newestFirst),
        authorize: true,
        compare: newestFirst,
        revalidate: row => {
          const read = changed.get(row.id);
          return read ? list.overlay(read)[0] ?? null : list.inject.revalidate(row);
        },
        identity: row => resolve(row.id),
      },
      authorizePage: async items => void authorized.push(items.map(({ id }) => id)),
    });
    return { cursor, authorized };
  }

  const ACKNOWLEDGED = ["acknowledged"] as const;
  /** The ids the provider lists as acknowledged, newest first. */
  const acknowledged = (host: IncidentProvider): string[] =>
    host.incidents.filter(({ status }) => status === "acknowledged").map(({ id }) => id);

  it("walks the provider's own pages when nothing is pending", async () => {
    const host = incidentProvider();
    const rows = host.incidents.filter(({ status }) => status === "acknowledged");

    const { cursor, authorized } = listIncidents(host, ACKNOWLEDGED);
    const pages = await drain(cursor);

    expect(pages).toEqual(pagesOf(rows, 4));
    // A row nothing targets is the provider's own object.
    expect(pages[0][0]).toBe(rows[0]);
    expect(authorized).toEqual(pagesOf(acknowledged(host), 4));
  });

  it("serves the stand-in of a pending create where it sorts, a later action on it folded in", async () => {
    const host = incidentProvider();
    // Opened unassigned, so triggered, between P05 and P06; acknowledging it brings it into the filter.
    const ref = host.open(89);
    host.stage({ kind: "acknowledge", incident: { id: ref } });
    // One nobody acknowledges stays out of a listing of acknowledged incidents.
    host.open(95);

    const { cursor, authorized } = listIncidents(host, ACKNOWLEDGED);
    expect(idsOf(await cursor.next())).toEqual(["P01", "P02", "P03", "P05"]);
    const second = await cursor.next();
    expect(idsOf(second)).toEqual([ref, "P06", "P07", "P08"]);
    expect(second?.[0]).toEqual({
      id: ref,
      status: "acknowledged",
      urgency: "high",
      assignees: [ME],
      serviceId: "svc-a",
      createdAt: at(89),
    });
    // The stand-in is authorized with the rows of its page.
    expect(authorized[1]).toEqual([ref, "P06", "P07", "P08"]);

    const rest = (await drain(cursor)).flat().map(({ id }) => id);
    expect(rest).toEqual(acknowledged(host).slice(7));
  });

  it("leaves out a row a pending action takes out of the filter, and fills the page", async () => {
    const host = incidentProvider();
    host.stage({ kind: "resolve", incident: { id: "P02" } });

    const { cursor, authorized } = listIncidents(host, ACKNOWLEDGED);
    expect(idsOf(await cursor.next())).toEqual(["P01", "P03", "P05", "P06"]);
    expect(authorized).toEqual([["P01", "P03", "P05", "P06"]]);
    expect((await drain(cursor)).flat().map(({ id }) => id)).not.toContain("P02");
  });

  it("serves a row a pending action moves into the filter once, where it sorts, authorized", async () => {
    const host = incidentProvider();
    // The provider's listing of acknowledged incidents leaves the triggered P04 out.
    host.stage({ kind: "acknowledge", incident: { id: "P04" } });
    // P06 is listed by the provider and read again by the listing: one incident, served once.
    host.stage({ kind: "reassign", incident: { id: "P06" }, to: ["bob"] });

    const { cursor, authorized } = listIncidents(host, ACKNOWLEDGED);
    const first = await cursor.next();
    expect(idsOf(first)).toEqual(["P01", "P02", "P03", "P04"]);
    expect(first?.[3]).toEqual({ ...host.read("P04"), status: "acknowledged", assignees: [ME] });
    expect(authorized).toEqual([["P01", "P02", "P03", "P04"]]);

    const second = await cursor.next();
    expect(idsOf(second)).toEqual(["P05", "P06", "P07", "P08"]);
    expect(second?.[1].assignees).toEqual(["bob"]);

    const all = ["P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08",
      ...(await drain(cursor)).flat().map(({ id }) => id)];
    expect(all).toEqual(host.incidents.filter(({ id }) => id !== "P09").map(({ id }) => id));
  });

  it("drops the buffered stand-in of a create that applied mid-walk and serves the provider's row", async () => {
    const host = incidentProvider();
    // Assigned to the caller alone, so acknowledged as opened; between P10 and P11.
    const ref = host.open(79, { assignTo: [ME] });

    const { cursor } = listIncidents(host, ACKNOWLEDGED);
    // The first provider page reaches P14, so the stand-in is buffered behind this page.
    expect(idsOf(await cursor.next())).toEqual(["P01", "P02", "P03", "P05"]);

    // The create applies. The provider's row sorts where the provider's own time puts it, here
    // between P22 and P23, on a page the walk has not fetched.
    const created = pendingSummary({
      ref: "PNEW", serviceId: "svc-a", assignTo: [ME], stagedAt: at(55),
    }, ME);
    host.incidents.push(created);
    host.ids.bind(ref, "PNEW");
    host.settle(1);

    const rest = (await drain(cursor)).flat();
    expect(rest.map(({ id }) => id)).toEqual([
      "P06", "P07", "P08", "P10", "P11", "P12", "P13", "P14", "P15", "P16", "P17", "P18",
      "P19", "P20", "P21", "P22", "PNEW", "P23", "P24", "P25", "P26", "P27", "P28", "P29", "P30",
    ]);
    expect(rest.find(({ id }) => id === "PNEW")).toBe(created);
  });

  it("serves an incident once when its create applies after its stand-in was served", async () => {
    const host = incidentProvider();
    const ref = host.open(95, { assignTo: [ME] });

    const { cursor } = listIncidents(host, ACKNOWLEDGED);
    expect(idsOf(await cursor.next())).toEqual(["P01", "P02", ref, "P03"]);

    host.incidents.push(pendingSummary({
      ref: "PNEW", serviceId: "svc-a", assignTo: [ME], stagedAt: at(55),
    }, ME));
    host.ids.bind(ref, "PNEW");
    host.settle(1);

    // The cursor knows the provider's row as the stand-in it served: the listing's `identity`.
    const rest = (await drain(cursor)).flat().map(({ id }) => id);
    expect(rest).toEqual(acknowledged(host).slice(3).filter(id => id !== "PNEW"));
  });

  it("serves the provider's row alone for a create that is bound but still listed as pending", async () => {
    const host = incidentProvider();
    const ref = host.open(95, { assignTo: [ME] });
    const created: Incident = {
      id: "PNEW", status: "acknowledged", urgency: "low", assignees: ["ann"],
      serviceId: "svc-a", createdAt: at(99),
    };
    host.incidents.push(created);
    host.ids.bind(ref, "PNEW");

    const { cursor } = listIncidents(host, ACKNOWLEDGED);
    const first = await cursor.next();
    expect(idsOf(first)).toEqual(["PNEW", "P01", "P02", "P03"]);
    // As the provider has it, not as the create's summary would give it.
    expect(first?.[0]).toBe(created);
    expect((await drain(cursor)).flat().map(({ id }) => id)).not.toContain(ref);
  });

  it("folds an action on a temporary id into the provider's row of a create bound during the fetch", async () => {
    const host = incidentProvider();
    const ref = host.open(89);
    host.stage({ kind: "acknowledge", incident: { id: ref } });
    // The create applies while the first page is being fetched, after that call's refresh ran.
    host.hooks.fetching = () => {
      host.hooks.fetching = undefined;
      host.incidents.push({
        id: "PNEW", status: "triggered", urgency: "high", assignees: [],
        serviceId: "svc-a", createdAt: at(99),
      });
      host.ids.bind(ref, "PNEW");
    };

    const { cursor } = listIncidents(host, ["triggered", "acknowledged"]);
    const first = await cursor.next();
    expect(idsOf(first)).toEqual(["PNEW", "P01", "P02", "P03"]);
    // The id resolved as the row was served, so the pending acknowledgement is on it.
    expect(first?.[0]).toEqual({
      id: "PNEW", status: "acknowledged", urgency: "high", assignees: [ME],
      serviceId: "svc-a", createdAt: at(99),
    });
    // The stand-in, buffered between P05 and P06, is the same incident and is not served.
    expect(idsOf(await cursor.next())).toEqual(["P04", "P05", "P06", "P07"]);
    expect((await drain(cursor)).flat().map(({ id }) => id)).not.toContain(ref);
  });

  it("serves the provider's row of a create bound during the fetch, though its stand-in sorts ahead", async () => {
    const host = incidentProvider();
    // The stand-in is newer than every provider row, so it sorts first on the first page.
    const ref = host.open(99);
    const real: Incident = {
      id: "PNEW", status: "triggered", urgency: "high", assignees: [],
      serviceId: "svc-a", createdAt: at(97),
    };
    // The create applies while the first page is being fetched, after that call's refresh ran,
    // and the provider's row is on that page, between P01 and P02.
    host.hooks.fetching = () => {
      host.hooks.fetching = undefined;
      host.incidents.push(real);
      host.ids.bind(ref, "PNEW");
    };

    const { cursor } = listIncidents(host, ["triggered", "acknowledged"]);
    const first = await cursor.next();
    expect(idsOf(first)).toEqual(["P01", "PNEW", "P02", "P03"]);
    expect(first?.[1]).toBe(real);
    expect((await drain(cursor)).flat().map(({ id }) => id)).not.toContain(ref);
  });

  it("drops the stand-in of a create rejected while the page that would serve it is fetched", async () => {
    const host = incidentProvider();
    // Triggered and newer than every provider row, so it sorts first on the first page.
    const ref = host.open(99);
    // The create is rejected while the first page is being fetched, after that call's refresh ran.
    host.hooks.fetching = () => {
      host.hooks.fetching = undefined;
      host.settle(1);
    };

    const { cursor } = listIncidents(host, ["triggered", "acknowledged"]);
    expect(idsOf(await cursor.next())).toEqual(["P01", "P02", "P03", "P04"]);
    expect((await drain(cursor)).flat().map(({ id }) => id)).not.toContain(ref);
  });

  it("shows an action staged mid-walk on the rows served after it", async () => {
    const host = incidentProvider();

    const { cursor } = listIncidents(host, ACKNOWLEDGED);
    expect(idsOf(await cursor.next())).toEqual(["P01", "P02", "P03", "P05"]);

    // P07 and P08 are buffered: fetched before these were staged, served after.
    host.stage({ kind: "reassign", incident: { id: "P07" }, to: ["bob"] });
    host.stage({ kind: "resolve", incident: { id: "P08" } });
    const second = await cursor.next();
    expect(idsOf(second)).toEqual(["P06", "P07", "P10", "P11"]);
    expect(second?.[1]).toEqual({ ...host.read("P07"), assignees: ["bob"] });
  });

  it("stops serving the rows and stand-ins of a service the listing loses mid-walk", async () => {
    const host = incidentProvider();
    // Between P10 and P11, on the second service, as P10 is.
    const ref = host.open(79, { serviceId: "svc-b", assignTo: [ME] });

    const { cursor } = listIncidents(host, ACKNOWLEDGED);
    expect(idsOf(await cursor.next())).toEqual(["P01", "P02", "P03", "P05"]);

    host.services.delete("svc-b");
    const rest = (await drain(cursor)).flat().map(({ id }) => id);
    expect(rest.slice(0, 4)).toEqual(["P06", "P07", "P08", "P11"]);
    expect(rest).not.toContain(ref);
    expect(rest).toEqual(acknowledged(host).slice(4).filter(id => host.read(id)?.serviceId === "svc-a"));
  });
});

describe("a message listing over a TokenCursor", () => {
  type Mark = "update" | "draft" | "move" | "delete" | "send";
  type Message = {
    readonly id: string;
    readonly folderId: string;
    readonly folder: string;
    readonly subject: string;
    readonly isRead: boolean;
    readonly isDraft: boolean;
    readonly receivedAt: string;
    readonly pending?: Mark;
  };
  type MailAction =
    | { kind: "moveMessages"; messages: readonly { id: string }[]; to: { id: string }; as?: "delete" }
    | { kind: "updateMessages"; messages: readonly { id: string }[]; change: { isRead: boolean } }
    | { kind: "createDraft"; ref: string; subject: string; submittedAt: string }
    | { kind: "updateDraft"; draftId: string; subject: string }
    | { kind: "deleteDraft"; draftId: string }
    | { kind: "send"; draft?: { id: string } };
  type Staged = SimulationRecord<MailAction>;

  const INBOX = "f-inbox";
  const ARCHIVE = "f-archive";
  const DRAFTS = "f-drafts";
  const DELETED = "f-deleted";
  const PATHS: Record<string, string> = {
    [INBOX]: "Inbox", [ARCHIVE]: "Archive", [DRAFTS]: "Drafts", [DELETED]: "Deleted Items",
  };
  const newestFirst = (a: Message, b: Message): number => b.receivedAt.localeCompare(a.receivedAt);
  const message = (id: string, folderId: string, minute: number, isDraft = false): Message => ({
    id, folderId, folder: PATHS[folderId], subject: `About ${id}`, isRead: isDraft, isDraft,
    receivedAt: at(minute),
  });

  /**
   * A mailbox of thirty-one messages: M01 to M20 in the Inbox, two minutes apart from the 98th
   * down; A01 to A05 in the Archive, older; D01 to D06 in Drafts, four minutes apart from the
   * 96th down. With it, a journal of staged actions and the temporary ids of pending drafts.
   */
  function mailbox() {
    const ids = new ProvisionalIds<string>(fakeKv(), { namespace: "mail:", isProvisional });
    const messages: Message[] = [
      ...Array.from({ length: 20 }, (_, i) => message(numbered("M", i + 1), INBOX, 98 - 2 * i)),
      ...Array.from({ length: 5 }, (_, i) => message(numbered("A", i + 1), ARCHIVE, 48 - 2 * i)),
      ...Array.from({ length: 6 }, (_, i) => message(numbered("D", i + 1), DRAFTS, 96 - 4 * i, true)),
    ];
    const journal: Staged[] = [];
    const stage = (action: MailAction): void => void journal.push({ id: journal.length + 1, action });
    return {
      ids,
      messages,
      stage,
      /** Stages a draft, submitted at `minute`, under a fresh temporary id. */
      draft: (minute: number, subject: string): string => {
        const ref = ids.allocate(n => `~${n}`);
        stage({ kind: "createDraft", ref, subject, submittedAt: at(minute) });
        return ref;
      },
      move: (to: string, ...messageIds: string[]): void =>
        stage({ kind: "moveMessages", messages: messageIds.map(id => ({ id })), to: { id: to } }),
      pending: (): readonly Staged[] => [...journal],
      folderPath: async (folderId: string): Promise<string> => PATHS[folderId] ?? "",
      /** One page of a folder, newest first, with a token while there is more. */
      page: async (folderId: string, token: string | undefined, perPage: number) => {
        const from = Number(token ?? 0);
        const rows = messages.filter(row => row.folderId === folderId).toSorted(newestFirst);
        return {
          items: rows.slice(from, from + perPage),
          ...(from + perPage < rows.length && { nextToken: String(from + perPage) }),
        };
      },
      read: (id: string): Message | undefined => messages.find(row => row.id === id),
    };
  }
  type Mailbox = ReturnType<typeof mailbox>;

  const RANK: Record<Mark, number> = { update: 1, draft: 2, move: 3, delete: 3, send: 4 };
  /** The stronger of a row's mark and a record's, the record's between equals: never lowered. */
  const raised = (now: Mark | undefined, next: Mark): Mark =>
    now !== undefined && RANK[now] > RANK[next] ? now : next;

  /** The messages of one folder, newest first, as pending actions leave them. */
  async function listMessages(
    host: Mailbox,
    listedFolder: string,
    { pageSize = 5, remotePageSize = 10 } = {},
  ) {
    const resolve = (id: string): string => host.ids.resolve(id);
    const targets = (action: MailAction): readonly string[] => {
      switch (action.kind) {
        case "moveMessages":
        case "updateMessages":
          return action.messages.map(({ id }) => id);
        case "createDraft":
          return resolve(action.ref) === action.ref ? [action.ref] : [];
        case "updateDraft":
        case "deleteDraft":
          return [resolve(action.draftId)];
        case "send":
          return action.draft ? [resolve(action.draft.id)] : [];
      }
    };

    let pending = host.pending();
    // The reducer is synchronous, so the paths of the folders pending moves name are read ahead
    // of the walk and again in `refresh`.
    const paths = new Map<string, string>();
    const readPaths = async (): Promise<void> => {
      for (const { action } of pending) {
        if (action.kind !== "moveMessages") continue;
        const to = resolve(action.to.id);
        if (!paths.has(to)) paths.set(to, await host.folderPath(to));
      }
    };
    await readPaths();
    const draftsPath = await host.folderPath(DRAFTS);

    const store = createSimulationStore<string, Message, Message, Staged>({
      initial: row => row,
      // A move is compared with the folder the provider has the message in, and a mark is raised
      // by rank whatever the order of the records, so that the fold reads as the last move, the
      // strongest mark and the latest edit. One sequence it reads differently from an index of
      // the pending actions by message: an update, a move away and a move back. The move back
      // takes the move's mark off, and the update's went under it, so the fold answers no mark
      // where the index answers `update`. Which of the two a listing shows is the gatekeeper's
      // to decide.
      reduce: (row, { action }, { base }): EntityStep<Message> => {
        const none = { kind: "known-no-effect" } as const;
        const applied = (value: Message) => ({ kind: "applied", value }) as const;
        if (action.kind === "createDraft") {
          return row !== undefined ? none : applied({
            id: action.ref, folderId: DRAFTS, folder: draftsPath, subject: action.subject,
            isRead: true, isDraft: true, receivedAt: action.submittedAt, pending: "draft",
          });
        }
        if (row === undefined) return none;
        switch (action.kind) {
          case "moveMessages": {
            const to = resolve(action.to.id);
            if (to !== base?.folderId) {
              return applied({
                ...row, folderId: to, folder: paths.get(to) ?? "",
                pending: raised(row.pending, action.as === "delete" ? "delete" : "move"),
              });
            }
            // Back where the provider has it: unmoved, with the mark of the move taken off.
            const { pending: mark, ...unmarked } = row;
            const moved = mark === "move" || mark === "delete";
            return applied({
              ...unmarked, folderId: base.folderId, folder: base.folder,
              ...(mark !== undefined && !moved && { pending: mark }),
            });
          }
          case "updateMessages":
            return applied({
              ...row, isRead: action.change.isRead, pending: raised(row.pending, "update"),
            });
          case "updateDraft":
            return row.isDraft
              ? applied({ ...row, subject: action.subject, pending: raised(row.pending, "update") })
              : none;
          case "deleteDraft":
            return { kind: "deleted" };
          case "send":
            return applied({ ...row, pending: "send" });
        }
      },
    });

    // Messages whose last pending move puts them in this folder are read by id and listed first.
    const lastMove = new Map<string, string>();
    for (const { action } of pending) {
      if (action.kind !== "moveMessages") continue;
      for (const { id } of action.messages) lastMove.set(id, resolve(action.to.id));
    }
    const movedIn = [...lastMove].filter(([, to]) => to === listedFolder).map(([id]) => id);
    // That lead is part of the order, so the cursor places a pending draft after the messages
    // moved in, whose places it compares the draft with first.
    const lead = (row: Message): number => {
      const index = movedIn.indexOf(row.id);
      return index < 0 ? movedIn.length : index;
    };

    // The index of the pending actions is kept, and built again when they are read again: no
    // message's id changes mid-walk.
    let view = createSimulationView(pending, targets);
    const list = simulatedList({
      store,
      view: () => view,
      id: row => row.id,
      compare: (a, b) => lead(a) - lead(b) || newestFirst(a, b),
      keeps: row => row.folderId === listedFolder,
      // Pending drafts are in Drafts and nowhere else.
      created: () => listedFolder !== DRAFTS ? [] : host.pending().flatMap(({ action }) =>
        action.kind === "createDraft" && resolve(action.ref) === action.ref ? [action.ref] : []),
    });


    return new TokenCursor<Message>({
      pageSize,
      remotePageSize,
      refresh: async () => {
        pending = host.pending();
        await readPaths();
        view = createSimulationView(pending, targets);
        list.refresh();
      },
      overlay: list.overlay,
      inject: { ...list.inject, authorize: true, identity: row => row.id },
      fetchPage: async (token, perPage) => {
        // By the token, not a flag: a first page whose fetch failed is fetched again with it.
        const moved = token === undefined ? movedIn.flatMap(id => host.read(id) ?? []) : [];
        const page = await host.page(listedFolder, token, perPage);
        // A message read by id is not listed again where the provider's page has it.
        const kept = page.items.filter(row => !movedIn.includes(row.id));
        return { ...page, items: [...moved, ...kept] };
      },
      authorizePage: async () => {},
    });
  }

  const inFolder = (host: Mailbox, folderId: string): string[] =>
    host.messages.filter(row => row.folderId === folderId).map(({ id }) => id);

  it("marks each of the messages one pending update names", async () => {
    const host = mailbox();
    host.stage({
      kind: "updateMessages",
      messages: [{ id: "M02" }, { id: "M03" }, { id: "M06" }],
      change: { isRead: true },
    });

    const cursor = await listMessages(host, INBOX);
    const rows = (await drain(cursor)).flat();

    expect(rows.map(({ id }) => id)).toEqual(inFolder(host, INBOX));
    for (const row of rows) {
      expect(row).toEqual(["M02", "M03", "M06"].includes(row.id)
        ? { ...host.read(row.id), isRead: true, pending: "update" }
        : host.read(row.id));
    }
  });

  it("leaves out a message moved or deleted out of the listed folder, and fills the page", async () => {
    const host = mailbox();
    host.move(ARCHIVE, "M02");
    host.stage({ kind: "moveMessages", messages: [{ id: "M04" }], to: { id: DELETED }, as: "delete" });

    const cursor = await listMessages(host, INBOX);
    expect(idsOf(await cursor.next())).toEqual(["M01", "M03", "M05", "M06", "M07"]);
    expect(idsOf(await cursor.next())).toEqual(["M08", "M09", "M10", "M11", "M12"]);
  });

  it("leaves out a draft a pending deletion hides, and fills the page", async () => {
    const host = mailbox();
    host.stage({ kind: "deleteDraft", draftId: "D02" });

    const cursor = await listMessages(host, DRAFTS);
    expect(idsOf(await cursor.next())).toEqual(["D01", "D03", "D04", "D05", "D06"]);
    expect(await cursor.next()).toBeNull();
  });

  it("serves a message moved in first, once, folded", async () => {
    const host = mailbox();
    host.move(INBOX, "A02");

    const cursor = await listMessages(host, INBOX);
    const first = await cursor.next();
    expect(idsOf(first)).toEqual(["A02", "M01", "M02", "M03", "M04"]);
    expect(first?.[0]).toEqual({
      ...host.read("A02"), folderId: INBOX, folder: "Inbox", pending: "move",
    });
    expect((await drain(cursor)).flat().map(({ id }) => id)).toEqual(inFolder(host, INBOX).slice(4));
  });

  it("serves a message moved in on a first page fetched again after its fetch failed", async () => {
    const host = mailbox();
    host.move(INBOX, "A02");
    const page = host.page;
    let failed = false;
    host.page = async (...args) => {
      if (failed) return page(...args);
      failed = true;
      throw new Error("unavailable");
    };

    const cursor = await listMessages(host, INBOX);
    await expect(cursor.next()).rejects.toThrow("unavailable");
    expect(idsOf(await cursor.next())).toEqual(["A02", "M01", "M02", "M03", "M04"]);
  });

  it("reads a message moved away and back as unmoved, and serves it once", async () => {
    const host = mailbox();
    host.move(ARCHIVE, "M07");
    host.move(INBOX, "M07");

    // Its last move names the listed folder, so it is read by id and listed first; the provider's
    // page lists it too, and the listing drops it there.
    const cursor = await listMessages(host, INBOX);
    const rows = (await drain(cursor)).flat();
    expect(rows.map(({ id }) => id))
      .toEqual(["M07", ...inFolder(host, INBOX).filter(id => id !== "M07")]);
    expect(rows[0]).toEqual(host.read("M07"));
    expect(rows[0]).not.toHaveProperty("pending");
  });

  it("marks by rank, not by the order the actions were staged in", async () => {
    const host = mailbox();
    host.stage({ kind: "send", draft: { id: "D01" } });
    host.move(ARCHIVE, "D01");
    host.move(ARCHIVE, "D02");
    host.stage({ kind: "send", draft: { id: "D02" } });
    host.stage({ kind: "updateMessages", messages: [{ id: "M03" }], change: { isRead: true } });
    host.move(ARCHIVE, "M03");

    const cursor = await listMessages(host, ARCHIVE);
    const first = await cursor.next();
    expect(idsOf(first)).toEqual(["D01", "D02", "M03", "A01", "A02"]);
    const moved = { folderId: ARCHIVE, folder: "Archive" };
    expect(first?.slice(0, 3)).toEqual([
      { ...host.read("D01"), ...moved, pending: "send" },
      { ...host.read("D02"), ...moved, pending: "send" },
      { ...host.read("M03"), ...moved, isRead: true, pending: "move" },
    ]);
  });

  it("lists pending drafts in Drafts where they sort, with the later actions on them folded in", async () => {
    const host = mailbox();
    // Staged oldest first; listed newest first, each between the provider's drafts around it.
    const earlier = host.draft(90, "First thoughts");
    const later = host.draft(94, "Reply");
    host.stage({ kind: "updateDraft", draftId: earlier, subject: "Second thoughts" });
    host.stage({ kind: "send", draft: { id: later } });
    const dropped = host.draft(86, "Never mind");
    host.stage({ kind: "deleteDraft", draftId: dropped });

    const cursor = await listMessages(host, DRAFTS);
    const rows = (await drain(cursor)).flat();
    expect(rows.map(({ id }) => id))
      .toEqual(["D01", later, "D02", earlier, "D03", "D04", "D05", "D06"]);
    const standIn = {
      folderId: DRAFTS, folder: "Drafts", isRead: true, isDraft: true,
    };
    expect(rows[1]).toEqual({
      ...standIn, id: later, subject: "Reply", receivedAt: at(94), pending: "send",
    });
    expect(rows[3]).toEqual({
      ...standIn, id: earlier, subject: "Second thoughts", receivedAt: at(90), pending: "draft",
    });
  });

  it("lists a pending draft after a message moved into Drafts, and among the provider's drafts", async () => {
    const host = mailbox();
    host.move(DRAFTS, "A02");
    const ref = host.draft(94, "Reply");

    // Provider pages of two, so the walk goes on past the first continuation token.
    const cursor = await listMessages(host, DRAFTS, { pageSize: 3, remotePageSize: 2 });
    expect((await drain(cursor)).map(page => page.map(({ id }) => id))).toEqual([
      ["A02", "D01", ref], ["D02", "D03", "D04"], ["D05", "D06"],
    ]);
  });

  it("lists no pending draft in another folder", async () => {
    const host = mailbox();
    host.draft(90, "First thoughts");

    const cursor = await listMessages(host, INBOX);
    expect((await drain(cursor)).flat().map(({ id }) => id)).toEqual(inFolder(host, INBOX));
  });

  it("shows an action staged after a row was buffered on the page that serves it", async () => {
    const host = mailbox();

    const cursor = await listMessages(host, INBOX);
    expect(idsOf(await cursor.next())).toEqual(["M01", "M02", "M03", "M04", "M05"]);

    // M07 and M08 were fetched with the first provider page, before these were staged.
    host.stage({ kind: "updateMessages", messages: [{ id: "M07" }], change: { isRead: true } });
    host.move(ARCHIVE, "M08");
    const second = await cursor.next();
    expect(idsOf(second)).toEqual(["M06", "M07", "M09", "M10", "M11"]);
    expect(second?.[1]).toEqual({ ...host.read("M07"), isRead: true, pending: "update" });
  });
});

describe("a stand-in whose filter changes while a page is fetched", () => {
  type Row = { id: string; at: number };
  type Queued = SimulationRecord<{ ref: string; at: number }>;

  it("serves the stand-in where the filter holds again as it is served", async () => {
    const queue: readonly Queued[] = [{ id: 1, action: { ref: "~1", at: 5 } }];
    let shown = true;
    const store = createSimulationStore<string, Row, Row, Queued>({
      initial: row => row,
      reduce: (row, { action }) => row === undefined
        ? { kind: "applied", value: { id: action.ref, at: action.at } }
        : { kind: "known-no-effect" },
    });
    const list = simulatedList({
      store,
      view: () => createSimulationView(queue, ({ ref }) => [ref]),
      id: row => row.id,
      compare: (a, b) => b.at - a.at,
      keeps: () => shown,
      created: () => ["~1"],
    });
    // The stand-in is listed as the walk opens. The filter then leaves it out at the walk's
    // refresh, and holds again while the page is fetched.
    shown = false;
    const cursor = new OffsetCursor<Row>({
      pageSize: 4,
      fetchPage: async (offset, limit) => {
        shown = true;
        return [{ id: "r1", at: 10 }].slice(offset, offset + limit);
      },
      refresh: async () => list.refresh(),
      overlay: list.overlay,
      inject: { ...list.inject, authorize: true, identity: row => row.id },
      authorizePage: async () => {},
    });

    expect(await drain(cursor)).toEqual([[{ id: "r1", at: 10 }, { id: "~1", at: 5 }]]);
  });
});

describe("the folds of one walk", () => {
  type Row = { id: string; at: number; labels: string[] };
  type Change =
    | { kind: "open"; ref: string; at: number }
    | { kind: "label"; row: string; label: string };
  type Queued = SimulationRecord<Change>;

  /** Six provider rows, newest first, and the page sizes of the walk. */
  const PROVIDER_ROWS = 6;
  const PAGE_SIZE = 2;
  const REMOTE_PAGE_SIZE = 2;
  /** Two records on the provider's first row; a create and one record on its stand-in. */
  const QUEUE: readonly Queued[] = [
    { id: 1, action: { kind: "label", row: "r1", label: "a" } },
    { id: 2, action: { kind: "label", row: "r1", label: "b" } },
    { id: 3, action: { kind: "open", ref: "~1", at: 35 } },
    { id: 4, action: { kind: "label", row: "~1", label: "c" } },
  ];
  const targets = (action: Change): string[] =>
    action.kind === "open" ? [action.ref] : [action.row];
  /** The refusal of the first page, which a walk retries once. */
  const REFUSED = new Error("refused");

  /**
   * One listing over `QUEUE`, walked to its end: every `next()` counted, the one that rejects
   * and the one that answers `null` included, with the record ids `reduce` was given and the
   * row ids `initial` was given, each in call order.
   */
  async function walk({ inPlace, refuseFirstPage }: { inPlace: boolean; refuseFirstPage: boolean }) {
    const provided: Row[] = Array.from({ length: PROVIDER_ROWS }, (_, index) =>
      ({ id: `r${index + 1}`, at: (PROVIDER_ROWS - index) * 10, labels: [] }));
    const reduced: number[] = [];
    const drafted: string[] = [];
    const store = createSimulationStore<string, Row, Row, Queued>({
      initial: row => {
        drafted.push(row.id);
        return inPlace ? { ...row, labels: [...row.labels] } : row;
      },
      reduce: (row, { id, action }) => {
        reduced.push(id);
        if (action.kind === "open") {
          return row === undefined
            ? { kind: "applied", value: { id: action.ref, at: action.at, labels: [] } }
            : { kind: "known-no-effect" };
        }
        if (row === undefined) return { kind: "known-no-effect" };
        if (!inPlace) {
          return { kind: "applied", value: { ...row, labels: [...row.labels, action.label] } };
        }
        row.labels.push(action.label);
        return { kind: "applied", value: row };
      },
    });
    const list = simulatedList({
      store,
      view: () => createSimulationView(QUEUE, targets),
      id: row => row.id,
      compare: (a, b) => b.at - a.at,
      created: () => ["~1"],
    });
    let authorized = 0;
    const cursor = new OffsetCursor<Row>({
      pageSize: PAGE_SIZE,
      remotePageSize: REMOTE_PAGE_SIZE,
      fetchPage: async (offset, limit) => provided.slice(offset, offset + limit),
      refresh: async () => list.refresh(),
      overlay: list.overlay,
      inject: { ...list.inject, authorize: true, identity: row => row.id },
      authorizePage: async () => {
        if (authorized++ === 0 && refuseFirstPage) throw REFUSED;
      },
    });

    let calls = 0;
    let refusedCalls = 0;
    const pages: Row[][] = [];
    for (;;) {
      calls++;
      let page: Row[] | null;
      try {
        page = await cursor.next();
      } catch (error) {
        // The one refusal this walk makes is retried; anything else fails the test.
        if (error !== REFUSED || refusedCalls > 0) throw error;
        refusedCalls++;
        continue;
      }
      if (page === null) break;
      pages.push(page);
    }
    return { calls, refusedCalls, pages, reduced, drafted, provided };
  }

  const times = <T>(list: readonly T[], item: T): number =>
    list.filter(other => other === item).length;

  // The hooks fold a stand-in once when they are made, and the cursor refreshes them at every
  // `next()`, the refused one and the one that reports the end included. A provider row is
  // folded each time the cursor builds a page with it: once, and again when its page was refused
  // and is built again.
  it.each([
    { refuseFirstPage: false, calls: 5, onRow: 1, onStandIn: 6, total: 14 },
    { refuseFirstPage: true, calls: 6, onRow: 2, onStandIn: 7, total: 18 },
  ])("reduces a provider row's records each time its page is built, and a stand-in's when the " +
    "hooks are made and at every next() (first page refused: $refuseFirstPage)",
  async ({ refuseFirstPage, calls, onRow, onStandIn, total }) => {
    for (const inPlace of [false, true]) {
      const walked = await walk({ inPlace, refuseFirstPage });

      expect(walked.calls).toBe(calls);
      expect(walked.refusedCalls).toBe(refuseFirstPage ? 1 : 0);
      expect([1, 2, 3, 4].map(id => times(walked.reduced, id))).toEqual(
        [onRow, onRow, onStandIn, onStandIn]);
      expect(walked.reduced).toHaveLength(total);
      expect(walked.pages.map(page => page.map(({ id, labels }) => [id, labels]))).toEqual([
        [["r1", ["a", "b"]], ["r2", []]],
        [["r3", []], ["~1", ["c"]]],
        [["r4", []], ["r5", []]],
        [["r6", []]],
      ]);
    }
  });

  // The cursor gives `overlay` the row it holds each time it builds the row's page, which the
  // count of `initial` calls shows. A reducer that works in place is exact there because
  // `initial` copies: the labels are folded once into the row served, and the provider's rows
  // are left as they were fetched.
  it("gives overlay the row a refused page held again, and serves it as it did the first time " +
    "with a reducer that works in place", async () => {
    const { pages, drafted, provided } = await walk({ inPlace: true, refuseFirstPage: true });

    expect(["r1", "r2", "r3", "r4", "r5", "r6", "~1"].map(id => times(drafted, id))).toEqual(
      [2, 2, 1, 1, 1, 1, 0]);
    expect(pages[0]).toEqual([
      { id: "r1", at: 60, labels: ["a", "b"] },
      { id: "r2", at: 50, labels: [] },
    ]);
    for (const row of pages.flat()) expect(provided).not.toContain(row);
    for (const row of provided) expect(row.labels).toEqual([]);
  });
});
