import { z } from "zod";
import { defineTaskEval } from "../src/eval.js";
import { defineEvalTask } from "../src/task.js";

const DOCUMENT = z.object({
  revision: z.number().int().nonnegative(),
  title: z.string(),
  blocks: z.array(z.object({
    id: z.string(),
    html: z.string(),
    version: z.number().int().nonnegative(),
  }).loose()).nullable(),
}).loose();

type Document = z.infer<typeof DOCUMENT>;

interface DocsApi {
  getDocument(): Promise<Document>;
}

const TITLE = "Harbour Refit";

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function distinctTopicIndexes(items: readonly string[], topics: readonly string[]): number[] | null {
  const indexes: number[] = [];
  const used = new Set<number>();
  const assign = (topicIndex: number): boolean => {
    const topic = topics.at(topicIndex);
    if (topic === undefined) return true;
    for (const [itemIndex, item] of items.entries()) {
      if (used.has(itemIndex) || !item.includes(topic) ||
          item.length < topic.length + 12 || !/[.!?]/.test(item)) continue;
      used.add(itemIndex);
      indexes.push(itemIndex);
      if (assign(topicIndex + 1)) return true;
      indexes.pop();
      used.delete(itemIndex);
    }
    return false;
  };
  return assign(0) ? indexes : null;
}

const task = defineEvalTask({
  id: "project-doc",
  turns: [{
    prompt: `I'm kicking off a project called Harbour Refit. Set me up a doc named exactly
"${TITLE}" for my running notes on it.

Start it off with a heading for the project and three bullet points, one each for scope, budget and
timeline. Put a sentence of placeholder detail under each. I'll replace them as things firm up.`,
    verify: async verifier => {
      await verifier.check("is-presented-as-a-document-output", async () => {
        const doc = verifier.workpieces.find(workpiece => workpiece.title === TITLE);
        return {
          pass: doc?.output?.id === "document",
          evidence: verifier.workpieces.map(workpiece => ({
            title: workpiece.title,
            outputId: workpiece.output?.id ?? null,
          })),
        };
      });

      await verifier.check("answers-the-docs-contract-with-real-content", async () => {
        using api = await verifier.connect<DocsApi>(TITLE);
        const document = DOCUMENT.parse(await api.getDocument());
        const html = (document.blocks ?? []).map(block => block.html).join("\n");
        const listItems = [...html.matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/gi)]
            .map(match => plainText(match[1] ?? ""));
        const headings = [...html.matchAll(/<h[1-6](?:\s[^>]*)?>([\s\S]*?)<\/h[1-6]>/gi)]
            .map(match => plainText(match[1] ?? ""));
        const requiredItems = ["scope", "budget", "timeline"];
        const topicIndexes = distinctTopicIndexes(listItems, requiredItems);

        // Collect headings and list items with their source positions rather than as
        // independent collections: the prompt asks the document to START with the project
        // heading, so the matching heading must precede the first list item in source order.
        let headingIndex: number | null = null;
        for (const match of html.matchAll(/<h[1-6](?:\s[^>]*)?>([\s\S]*?)<\/h[1-6]>/gi)) {
          const heading = plainText(match[1] ?? "");
          if (heading.includes("harbour") && heading.includes("refit")) {
            headingIndex = match.index ?? null;
            break;
          }
        }
        let listItemIndex: number | null = null;
        for (const match of html.matchAll(/<li(?:\s[^>]*)?>/gi)) {
          listItemIndex = match.index ?? null;
          break;
        }

        return {
          pass: document.revision >= 1 && document.blocks !== null &&
            document.title === TITLE &&
            headingIndex !== null && listItemIndex !== null &&
            headingIndex < listItemIndex &&
            listItems.length === 3 && topicIndexes !== null,
          evidence: {
            revision: document.revision,
            title: document.title,
            blockCount: document.blocks?.length ?? null,
            listItems,
            headings,
            topicIndexes,
            headingIndex,
            listItemIndex,
          },
        };
      });
    },
  }],
});

defineTaskEval(task);
