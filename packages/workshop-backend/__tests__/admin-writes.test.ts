import { describe, expect, it } from "vitest";
import {
  ADMIN_WRITE_ACTIONS,
  type AdminWriteAction, type AdminWriteArgs,
} from "@gadgets/workshop-shared/api";
import { adminWriteArgs } from "../src/admin-writes.js";

// A value each argument accepts.
const VALID: Required<AdminWriteArgs> = { chatId: 3 };
const ALL_ARGS = Object.keys(VALID) as (keyof AdminWriteArgs)[];

// What each action takes, written out here rather than read from the code under test.
const TAKES: Record<AdminWriteAction,
    { required: (keyof AdminWriteArgs)[]; optional: (keyof AdminWriteArgs)[] }> = {
  stopAgent: { required: ["chatId"], optional: [] },
  restartWorkspace: { required: [], optional: [] },
};

function pick(names: (keyof AdminWriteArgs)[]): AdminWriteArgs {
  return Object.fromEntries(names.map(name => [name, VALID[name]]));
}

/** The message of the TypeError `call` throws. */
function typeError(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return (error as TypeError).message;
  }
  throw new Error("Expected the call to throw.");
}

describe("adminWriteArgs", () => {
  it("covers every action", () => {
    expect(Object.keys(TAKES).toSorted()).toEqual([...ADMIN_WRITE_ACTIONS].toSorted());
  });

  describe.each(ADMIN_WRITE_ACTIONS)("%s", action => {
    const { required, optional } = TAKES[action];
    const full = pick([...required, ...optional]);

    it("accepts exactly its arguments", () => {
      expect(adminWriteArgs(action, full)).toStrictEqual(full);
      expect(adminWriteArgs(action, pick(required))).toStrictEqual(pick(required));
      // An argument left undefined is one not given.
      const padded = { ...full, ...Object.fromEntries(ALL_ARGS.map(name => [name, full[name]])) };
      expect(adminWriteArgs(action, padded)).toStrictEqual(full);
    });

    it("refuses a request missing a required argument, naming it", () => {
      for (let name of required) {
        const { [name]: _missing, ...rest } = full;
        expect(typeError(() => adminWriteArgs(action, rest)))
            .toBe(`"${action}" needs \`${name}\`.`);
      }
    });

    it("refuses every argument it does not take, naming it", () => {
      for (let name of ALL_ARGS) {
        if (name in full) continue;
        expect(typeError(() => adminWriteArgs(action, { ...full, [name]: VALID[name] })))
            .toBe(`"${action}" takes no \`${name}\`.`);
      }
    });
  });

  it("refuses a property that is no argument at all without repeating its name", () => {
    for (let name of ["chatID", "x".repeat(5000), "constructor", "__proto__"]) {
      const args = JSON.parse(JSON.stringify({ chatId: 3, [name]: 4 })) as AdminWriteArgs;
      expect(typeError(() => adminWriteArgs("stopAgent", args)))
          .toBe("\"stopAgent\" was given an argument no write takes.");
    }
  });

  it("refuses an unknown action, an inherited property name included", () => {
    for (let action of ["bogus", "constructor", "toString", "__proto__", ""]) {
      expect(typeError(() => adminWriteArgs(action as AdminWriteAction, {})))
          .toBe("No such write action.");
    }
  });

  // Ids start at 0: a workspace's first chat has it.
  it("refuses a chatId that is not a non-negative safe integer", () => {
    for (let value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(typeError(() => adminWriteArgs("stopAgent", { chatId: value })))
          .toBe("`chatId` must be a non-negative whole number.");
    }
    expect(adminWriteArgs("stopAgent", { chatId: 0 }).chatId).toBe(0);
    expect(adminWriteArgs("stopAgent", { chatId: Number.MAX_SAFE_INTEGER }).chatId)
        .toBe(Number.MAX_SAFE_INTEGER);
  });

  it("refuses an argument it does not take when its value is 0", () => {
    expect(typeError(() => adminWriteArgs("restartWorkspace", { chatId: 0 })))
        .toBe("\"restartWorkspace\" takes no `chatId`.");
  });

  it("refuses an action ADMIN_WRITE_ACTIONS does not list and an argument AdminWriteArgs does " +
      "not declare", () => {
    for (let action of ["retryAgent", "addCollaborator", "revertChat", "revertGadget",
        "deleteGadget", "deleteWorkspace", "removeConnection"]) {
      // With the arguments a client might send with it, and with none.
      for (let args of [{}, VALID]) {
        expect(typeError(() => adminWriteArgs(action as AdminWriteAction, args)))
            .toBe("No such write action.");
      }
    }

    const undeclared = {
      modelId: "provider/model", revertFrom: 12, gadgetId: 5,
      commitId: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567", username: "bob@example.test",
      grant: "workspace", note: "",
    };
    for (let action of ADMIN_WRITE_ACTIONS) {
      const { required, optional } = TAKES[action];
      const full = pick([...required, ...optional]);
      for (let [name, value] of Object.entries(undeclared)) {
        expect(typeError(() => adminWriteArgs(action, { ...full, [name]: value })))
            .toBe(`"${action}" was given an argument no write takes.`);
      }
    }
  });
});
