import { defineEvalSuite } from "../src/suite.js";
import { tasksFor } from "../tasks/index.js";

defineEvalSuite(tasksFor("frontier"));
