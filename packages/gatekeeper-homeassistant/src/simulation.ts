// Simulation of Home Assistant state under pending (submitted-but-not-yet-applied) actions.
//
// The approval-queue lifecycle means actions can sit in the queue for a while before the user
// approves them. Without simulation, an agent that submits a write and then immediately reads
// state would see the pre-action state, which is confusing — the agent might keep retrying
// thinking its write didn't take. With simulation, reads reflect the world AS IF every pending
// action had already been applied, so the agent can chain calls and the user can batch-approve
// later.
//
// Implementation approach: overlay-at-read-time. Reads start from HA's real state, then walk
// the chronologically-ordered list of pending actions and apply each one's predicted effect.
// Pending actions live in `pending:*` rows in the gatekeeper's DO storage (already established
// by the approvals work).
//
// We only predict FINAL states — no animation, no transition timing. Many service calls have
// no predictable outcome (e.g. `script.turn_on`, `scene.activate`, custom services) and are
// left unsimulated; reads will return the pre-action state for those, which is honest.
//
// All helpers in this file are pure functions: they take inputs, return new objects, and never
// mutate the inputs (so caller can keep references to the real state if needed).

import type { HomeAssistantAction } from "./homeassistant";
import type { RegistrySnapshot } from "./homeassistant-api";
import { resolveTargets } from "./registry-utils";

// Re-export so existing callers (e.g. homeassistant.ts) keep working without an import switch.
export { resolveTargets };

/**
 * Raw HA state record shape (the shape returned by /api/states/<entity_id>). Mirrors HA's
 * snake_case naming because we operate on raw state before the normalize* helpers run.
 */
export interface HAStateRecord {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  context?: { id: string; user_id?: string | null; parent_id?: string | null };
}

// ---------------------------------------------------------------------------
// Per-service state mutation
//
// applyServiceToState returns a new HAStateRecord reflecting what the entity's state would
// look like AFTER the given service call is applied. Returns the input unchanged if we don't
// know how to predict the effect.

function withChangedState(state: HAStateRecord, newState: string, now: string): HAStateRecord {
  if (state.state === newState) {
    // No state change, but bump last_updated anyway since the action "happened".
    return { ...state, last_updated: now };
  }
  return { ...state, state: newState, last_changed: now, last_updated: now };
}

function withMergedAttributes(
  state: HAStateRecord,
  patch: Record<string, unknown>,
  now: string,
): HAStateRecord {
  return {
    ...state,
    attributes: { ...state.attributes, ...patch },
    last_updated: now,
  };
}

function applyServiceToState(
  state: HAStateRecord,
  action: HomeAssistantAction & { type: "callService" },
  now: string,
): HAStateRecord {
  const { domain, service, data } = action;
  const d = (data ?? {}) as Record<string, unknown>;

  switch (`${domain}.${service}`) {
    // -------- Generic on/off/toggle for many domains --------
    case "light.turn_on":
    case "switch.turn_on":
    case "fan.turn_on":
    case "input_boolean.turn_on":
    case "automation.turn_on":
    case "humidifier.turn_on":
    case "siren.turn_on":
    case "remote.turn_on": {
      let next = withChangedState(state, "on", now);
      if (domain === "light" && Object.keys(d).length > 0) {
        next = withMergedAttributes(next, d, now);
      }
      return next;
    }
    case "light.turn_off":
    case "switch.turn_off":
    case "fan.turn_off":
    case "input_boolean.turn_off":
    case "automation.turn_off":
    case "humidifier.turn_off":
    case "siren.turn_off":
    case "remote.turn_off":
      return withChangedState(state, "off", now);
    case "light.toggle":
    case "switch.toggle":
    case "fan.toggle":
    case "input_boolean.toggle":
    case "automation.toggle":
    case "siren.toggle":
    case "remote.toggle":
      return withChangedState(state, state.state === "on" ? "off" : "on", now);

    // -------- Cover --------
    case "cover.open_cover":
      return withChangedState(
        withMergedAttributes(state, { current_position: 100 }, now),
        "open",
        now,
      );
    case "cover.close_cover":
      return withChangedState(
        withMergedAttributes(state, { current_position: 0 }, now),
        "closed",
        now,
      );
    case "cover.stop_cover":
      // Final state is unknown for an in-flight cover; leave state.
      return { ...state, last_updated: now };
    case "cover.set_cover_position": {
      const pos = typeof d.position === "number" ? d.position : undefined;
      if (pos == null) return state;
      const newState = pos === 0 ? "closed" : "open";
      return withChangedState(withMergedAttributes(state, { current_position: pos }, now), newState, now);
    }

    // -------- Climate --------
    case "climate.set_temperature": {
      const patch: Record<string, unknown> = {};
      if (d.temperature != null) patch.temperature = d.temperature;
      if (d.target_temp_low != null) patch.target_temp_low = d.target_temp_low;
      if (d.target_temp_high != null) patch.target_temp_high = d.target_temp_high;
      let next = Object.keys(patch).length > 0 ? withMergedAttributes(state, patch, now) : state;
      if (typeof d.hvac_mode === "string") {
        next = withChangedState(next, d.hvac_mode, now);
      }
      return next;
    }
    case "climate.set_hvac_mode": {
      if (typeof d.hvac_mode === "string") {
        return withChangedState(state, d.hvac_mode, now);
      }
      return state;
    }
    case "climate.set_fan_mode": {
      if (typeof d.fan_mode === "string") {
        return withMergedAttributes(state, { fan_mode: d.fan_mode }, now);
      }
      return state;
    }
    case "climate.set_preset_mode": {
      if (typeof d.preset_mode === "string") {
        return withMergedAttributes(state, { preset_mode: d.preset_mode }, now);
      }
      return state;
    }
    case "climate.set_swing_mode": {
      if (typeof d.swing_mode === "string") {
        return withMergedAttributes(state, { swing_mode: d.swing_mode }, now);
      }
      return state;
    }

    // -------- Lock --------
    case "lock.lock":
      return withChangedState(state, "locked", now);
    case "lock.unlock":
      return withChangedState(state, "unlocked", now);
    case "lock.open":
      return withChangedState(state, "open", now);

    // -------- Media player --------
    case "media_player.media_play":
      return withChangedState(state, "playing", now);
    case "media_player.media_pause":
      return withChangedState(state, "paused", now);
    case "media_player.media_stop":
      return withChangedState(state, "idle", now);
    case "media_player.volume_set": {
      if (typeof d.volume_level === "number") {
        return withMergedAttributes(state, { volume_level: d.volume_level }, now);
      }
      return state;
    }
    case "media_player.volume_mute": {
      if (typeof d.is_volume_muted === "boolean") {
        return withMergedAttributes(state, { is_volume_muted: d.is_volume_muted }, now);
      }
      return state;
    }
    case "media_player.play_media": {
      const patch: Record<string, unknown> = {};
      if (d.media_content_id != null) patch.media_content_id = d.media_content_id;
      if (d.media_content_type != null) patch.media_content_type = d.media_content_type;
      let next = Object.keys(patch).length > 0 ? withMergedAttributes(state, patch, now) : state;
      next = withChangedState(next, "playing", now);
      return next;
    }
    case "media_player.turn_on":
      return withChangedState(state, "on", now);
    case "media_player.turn_off":
      return withChangedState(state, "off", now);

    // -------- Fan --------
    case "fan.set_percentage": {
      if (typeof d.percentage === "number") {
        const next = withMergedAttributes(state, { percentage: d.percentage }, now);
        // A percentage > 0 implies the fan is on; 0 implies off.
        return withChangedState(next, d.percentage > 0 ? "on" : "off", now);
      }
      return state;
    }
    case "fan.set_preset_mode": {
      if (typeof d.preset_mode === "string") {
        return withMergedAttributes(state, { preset_mode: d.preset_mode }, now);
      }
      return state;
    }

    // -------- Vacuum --------
    case "vacuum.start":
      return withChangedState(state, "cleaning", now);
    case "vacuum.stop":
      return withChangedState(state, "idle", now);
    case "vacuum.pause":
      return withChangedState(state, "paused", now);
    case "vacuum.return_to_base":
      return withChangedState(state, "returning", now);
    case "vacuum.clean_spot":
      return withChangedState(state, "cleaning", now);

    // -------- Helpers (input_*) and similar --------
    case "input_number.set_value":
    case "number.set_value": {
      if (typeof d.value === "number") {
        return withChangedState(state, String(d.value), now);
      }
      return state;
    }
    case "input_text.set_value":
    case "text.set_value": {
      if (typeof d.value === "string") {
        return withChangedState(state, d.value, now);
      }
      return state;
    }
    case "input_select.select_option":
    case "select.select_option": {
      if (typeof d.option === "string") {
        return withChangedState(state, d.option, now);
      }
      return state;
    }
    case "input_datetime.set_datetime": {
      if (typeof d.datetime === "string") return withChangedState(state, d.datetime, now);
      if (typeof d.date === "string" && typeof d.time === "string") {
        return withChangedState(state, `${d.date} ${d.time}`, now);
      }
      if (typeof d.date === "string") return withChangedState(state, d.date, now);
      if (typeof d.time === "string") return withChangedState(state, d.time, now);
      return state;
    }

    // -------- Cases that have no agent-observable state change --------
    case "automation.trigger":
    case "automation.reload":
    case "scene.turn_on":
    case "script.turn_on":
    case "script.reload":
    case "button.press":
    case "input_button.press":
    case "notify.send_message":
    case "homeassistant.reload":
    case "homeassistant.update_entity":
      // No state change to predict for the calling entity itself.
      return state;

    default:
      // Unknown service: leave state unchanged. This is the honest fallback — agents calling
      // custom or vendor services should know not to expect immediate state reflection.
      return state;
  }
}

// ---------------------------------------------------------------------------
// Action ordering and indexing

/** Sort pending actions chronologically. Action IDs are monotonically assigned by the
 * gatekeeper so they're a reliable proxy for submit order. */
export function sortActionsChronologically(actions: HomeAssistantAction[]): HomeAssistantAction[] {
  return [...actions].toSorted((a, b) => a.id - b.id);
}

/** Build a map of entity_id → ordered actions that target it, so each entity's overlay can be
 * computed in O(actions-for-it) instead of O(all-actions). */
export function indexPendingByEntity(
  pendingActions: HomeAssistantAction[],
  registry: RegistrySnapshot,
): Map<string, HomeAssistantAction[]> {
  const sorted = sortActionsChronologically(pendingActions);
  const index = new Map<string, HomeAssistantAction[]>();
  for (const action of sorted) {
    if (action.type !== "callService") continue;
    const targets = resolveTargets(action.target, registry);
    for (const entityId of targets) {
      let list = index.get(entityId);
      if (!list) {
        list = [];
        index.set(entityId, list);
      }
      list.push(action);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Public overlay helpers

/** Apply all pending actions that target this entity, in order, returning the simulated state. */
export function overlayEntityState(
  real: HAStateRecord,
  pendingActions: HomeAssistantAction[],
  registry: RegistrySnapshot,
  nowIso?: string,
): { state: HAStateRecord; appliedCount: number } {
  const now = nowIso ?? new Date().toISOString();
  const sorted = sortActionsChronologically(pendingActions);
  let current = real;
  let applied = 0;
  for (const action of sorted) {
    if (action.type !== "callService") continue;
    const targets = resolveTargets(action.target, registry);
    if (!targets.has(real.entity_id)) continue;
    const next = applyServiceToState(current, action, now);
    if (next !== current) {
      applied += 1;
      current = next;
    }
  }
  return { state: current, appliedCount: applied };
}

/** Apply the most recent pending saveDashboard action for the given dashboard URL path, if
 * any. Returns the simulated config (which may equal `real` if no pending dashboard save
 * targets this URL path). */
export function overlayDashboardConfig(
  real: unknown,
  urlPath: string | null,
  pendingActions: HomeAssistantAction[],
): { config: unknown; appliedCount: number } {
  const sorted = sortActionsChronologically(pendingActions);
  let current = real;
  let applied = 0;
  for (const action of sorted) {
    if (action.type !== "saveDashboard") continue;
    if (action.urlPath !== urlPath) continue;
    current = action.config;
    applied += 1;
  }
  return { config: current, appliedCount: applied };
}

/** Apply pending actions to a list of (real) state records, returning simulated records. The
 * index from `indexPendingByEntity` is reused across all records for efficiency. */
export function overlayEntityStates(
  realStates: HAStateRecord[],
  index: Map<string, HomeAssistantAction[]>,
  nowIso?: string,
): { states: HAStateRecord[]; totalApplied: number } {
  const now = nowIso ?? new Date().toISOString();
  const outStates: HAStateRecord[] = [];
  let totalApplied = 0;
  for (const real of realStates) {
    const actions = index.get(real.entity_id);
    if (!actions || actions.length === 0) {
      outStates.push(real);
      continue;
    }
    let current = real;
    for (const action of actions) {
      if (action.type !== "callService") continue;
      const next = applyServiceToState(current, action, now);
      if (next !== current) {
        current = next;
        totalApplied += 1;
      }
    }
    outStates.push(current);
  }
  return { states: outStates, totalApplied };
}
