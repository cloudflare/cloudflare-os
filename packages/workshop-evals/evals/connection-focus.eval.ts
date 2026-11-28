import { BUDGET, FORECAST, VIEWING, checkRead, checkWrites } from "./focus.js";
import { defineTaskEval } from "../src/eval.js";
import { defineEvalTask } from "../src/task.js";

// The user has a connection open beside the chat, one the agent has already read here, though the
// chat last spoke of another. They pick something in it and say "change this". The message says
// what they were viewing, so the agent has to change that, and not the one talked of last,
// through the binding the chat holds, and not build a Gadget for the request.

const holds = (url: string) => `What number does ${url} hold? Answer with the number alone.`;

const task = defineEvalTask({
  id: "connection-focus",
  turns: [{
    prompt: holds(BUDGET),
    verify: verifier => checkRead(verifier, BUDGET),
  }, {
    prompt: holds(FORECAST),
    verify: verifier => checkRead(verifier, FORECAST),
  }, {
    prompt: "Change this to 17.",
    focus: VIEWING,
    verify: verifier => checkWrites(verifier, [17]),
  }],
});

defineTaskEval(task);
