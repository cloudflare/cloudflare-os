import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ActionKind, ApprovalQueue, GitCache, HookController, HookDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { CalendarEventDraft, CalendarEventPatch, GoogleCalendarSession } from "../src/calendar-types";
import { GoogleCalendarGatekeeperImpl } from "../src/google";

export { GoogleCalendarGatekeeperImpl };

/** The calendar every facet of these hooks is bound to. */
export const TEST_CALENDAR_ID = "cal-1";

/** What one Calendar session call queued, or the error it threw. */
export type CalendarCall = { actionId?: number; action?: ActionDescription; error?: string };

class RecordingApprovalQueue extends RpcTarget implements ApprovalQueue {
  actionId?: number;
  action?: ActionDescription;

  async authorizeObservation(): Promise<void> {}

  async getGitCache(): Promise<GitCache> {
    throw new Error("Unexpected git cache access");
  }

  async submitAction(actionId: number, description: ActionDescription): Promise<void> {
    this.actionId = actionId;
    this.action = description;
  }

  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>,
    _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    throw new Error("Unexpected hook binding");
  }
}

/**
 * A queue that applies each action before replying, as an auto-approval may, and then loses the
 * reply.
 */
class ApplyThenLoseReplyQueue extends RecordingApprovalQueue {
  #apply: (actionId: number) => Promise<void>;

  constructor(apply: (actionId: number) => Promise<void>) {
    super();
    this.#apply = apply;
  }

  override async submitAction(actionId: number, description: ActionDescription): Promise<void> {
    await super.submitAction(actionId, description);
    await this.#apply(actionId);
    throw new Error("Network connection lost.");
  }
}

/** Drives Google Calendar gatekeeper facets, each bound to `TEST_CALENDAR_ID`. */
export class CalendarTestHooks extends DurableObject<Env> {
  #gatekeeper(facetName: string) {
    let userObjectId = this.ctx.exports.UserAccount.idFromName("test-user").toString();
    return this.ctx.facets.get<GoogleCalendarGatekeeperImpl>(facetName, () => ({
      class: this.ctx.exports.GoogleCalendarGatekeeperImpl({
        props: { userObjectId, calendarId: TEST_CALENDAR_ID, availabilityMode: "thisCalendar" },
      }),
    }));
  }

  async #call(
    facetName: string, body: (session: GoogleCalendarSession) => Promise<void>,
    queue = new RecordingApprovalQueue(),
  ): Promise<CalendarCall> {
    using approvalQueue = new RpcStub<ApprovalQueue>(queue);
    using session = await this.#gatekeeper(facetName).startSession(
      approvalQueue as unknown as ApprovalQueue,
    ) as GoogleCalendarSession & Disposable;
    try {
      await body(session);
      return { actionId: queue.actionId, action: queue.action };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async createEvent(facetName: string, event: CalendarEventDraft): Promise<CalendarCall> {
    return this.#call(facetName, session => session.createEvent(event));
  }

  async updateEvent(facetName: string, eventId: string, patch: CalendarEventPatch): Promise<CalendarCall> {
    return this.#call(facetName, session => session.updateEvent(eventId, patch));
  }

  /** `createEvent` through a queue that applies it and then loses the submit reply. */
  async createEventLosingReply(facetName: string, event: CalendarEventDraft): Promise<CalendarCall> {
    return this.#call(facetName, session => session.createEvent(event),
      new ApplyThenLoseReplyQueue(id => this.#gatekeeper(facetName).applyAction(id)));
  }

  /** `updateEvent` through a queue that applies it and then loses the submit reply. */
  async updateEventLosingReply(facetName: string, eventId: string, patch: CalendarEventPatch): Promise<CalendarCall> {
    return this.#call(facetName, session => session.updateEvent(eventId, patch),
      new ApplyThenLoseReplyQueue(id => this.#gatekeeper(facetName).applyAction(id)));
  }

  /** Apply an action, returning the error it threw, if any. */
  async applyAction(facetName: string, actionId: number): Promise<string | null> {
    try {
      await this.#gatekeeper(facetName).applyAction(actionId);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async autoApprovable(facetName: string): Promise<ActionKind[]> {
    return this.#gatekeeper(facetName).getAutoApprovableActions();
  }
}
