// The pure parts of admin writes to workspaces: what is computed from its arguments alone, with no
// storage read and no call made.

import type { AdminWriteAction, AdminWriteArgs, AdminWriteRecord } from "@gadgets/workshop-shared/api";

/** What OverseerDurableObject.applyAdminWrite() is given: the write, and the admin who makes it,
 * through which session, for the AdminWriteRecord the workspace appends. */
export type AdminWriteCall = Pick<AdminWriteRecord, "admin" | "sessionId" | "via" | "reason"> & {
  action: AdminWriteAction;
  args: AdminWriteArgs;
};

// The arguments each action takes: exactly the list in AdminWriteArgs' doc.
const WRITE_ARGS: Record<AdminWriteAction,
    { required: (keyof AdminWriteArgs)[]; optional?: (keyof AdminWriteArgs)[] }> = {
  stopAgent: { required: ["chatId"] },
  restartWorkspace: { required: [] },
};

// What an argument's value must be beyond its type, which the RPC validator has checked: `keep`
// returns the value to keep, or undefined for one that is refused.
type WriteArgRule<T> = { must: string; keep: (value: T) => T | undefined };

const ID: WriteArgRule<number> = {
  must: "be a non-negative whole number",
  keep: value => Number.isSafeInteger(value) && value >= 0 ? value : undefined,
};

// Every argument has a rule: one without does not compile.
type WriteArgValues = Required<AdminWriteArgs>;
const WRITE_ARG_RULES: { [Name in keyof WriteArgValues]: WriteArgRule<WriteArgValues[Name]> } = {
  chatId: ID,
};

// Puts `value` in `kept` under `name`, as its rule keeps it.
function keepWriteArg<Name extends keyof WriteArgValues>(
    kept: AdminWriteArgs, name: Name, value: WriteArgValues[Name]): void {
  let rule = WRITE_ARG_RULES[name];
  let clean = rule.keep(value);
  if (clean === undefined) throw new TypeError(`\`${name}\` must ${rule.must}.`);
  kept[name] = clean;
}

/** The arguments `action` takes, each validated and nothing else kept: throws TypeError for a
 * missing required one, one the action does not take, or a chat id that is not a non-negative
 * safe integer. */
export function adminWriteArgs(action: AdminWriteAction, args: AdminWriteArgs): AdminWriteArgs {
  // An own entry only: "constructor" names no action.
  if (!Object.hasOwn(WRITE_ARGS, action)) throw new TypeError("No such write action.");
  let { required, optional = [] } = WRITE_ARGS[action];
  let taken: string[] = [...required, ...optional];
  // The validator lets through properties the type does not declare, so every key is looked at.
  // Only an argument some write takes is named: a name the client made up is never repeated, since
  // the message is logged.
  for (let [name, value] of Object.entries(args)) {
    if (value !== undefined && !taken.includes(name)) {
      throw new TypeError(Object.hasOwn(WRITE_ARG_RULES, name)
          ? `"${action}" takes no \`${name}\`.`
          : `"${action}" was given an argument no write takes.`);
    }
  }

  // Built field by field from the table, so that nothing else the client sent is kept.
  let kept: AdminWriteArgs = {};
  for (let name of required) {
    let value = args[name];
    if (value === undefined) throw new TypeError(`"${action}" needs \`${name}\`.`);
    keepWriteArg(kept, name, value);
  }
  for (let name of optional) {
    let value = args[name];
    if (value !== undefined) keepWriteArg(kept, name, value);
  }
  return kept;
}
