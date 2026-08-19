import { z } from "zod";
import { defineEvalTask } from "../src/task.js";

const OkSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).loose(),
  z.object({ ok: z.literal(false), error: z.string().min(1) }).loose(),
]);

const ItemSchema = z.object({
  ingredient: z.string(),
  quantity: z.number(),
  unit: z.string(),
}).loose();

const ShoppingListSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), items: z.array(ItemSchema) }).loose(),
  z.object({ ok: z.literal(false), error: z.string().min(1) }).loose(),
]);

type Amount = { ingredient: string; quantity: number; unit: string };

interface KitchenApi {
  setStock(input: Amount): Promise<z.infer<typeof OkSchema>>;
  defineRecipe(input: {
    recipeId: string;
    name: string;
    servings: number;
    ingredients: Amount[];
  }): Promise<z.infer<typeof OkSchema>>;
  shoppingList(input: { recipeId: string; servings: number }):
    Promise<z.infer<typeof ShoppingListSchema>>;
}

/** Finds one shortfall row, tolerating the float error inherent in cross-unit conversion. */
function shortfall(
    list: Extract<z.infer<typeof ShoppingListSchema>, { ok: true }>,
    ingredient: string) {
  return list.items.find(item => item.ingredient === ingredient);
}

function near(actual: number | undefined, expected: number): boolean {
  return actual !== undefined && Math.abs(actual - expected) < 0.005;
}

/**
 * Pantry plus recipes plus a shopping list, which is where unit handling actually bites: the list is
 * a scaled recipe minus whatever is in stock, and the two are rarely recorded in the same unit.
 */
export default defineEvalTask({
  id: "pantry-kitchen",
  title: "Pantry and recipe shopping list",
  expectation: "required",
  turns: [{
    prompt: `Build a Gadget named exactly "Kitchen". It knows what is in my pantry and my recipes,
and tells me what to buy for a meal — the recipe scaled to the number of people, minus what I
already have. Store everything in the Gadget's own storage.

Quantities are decimal numbers. Support these units and convert between them within a family:
  mass:   g, kg (1 kg = 1000 g), oz (1 oz = 28.349523125 g), lb (1 lb = 453.59237 g)
  volume: ml, l (1 l = 1000 ml), tsp (1 tsp = 5 ml), tbsp (1 tbsp = 15 ml), cup (1 cup = 240 ml)
  count:  unit
Mass, volume and count never convert into one another. Round every quantity you return to three
decimal places.

It needs a stable server RPC taking and returning plain data, so I can verify it:

- setStock({ ingredient: string, quantity: number >= 0, unit: string })
  -> { ok: true } | { ok: false, error: string }
  Records how much of that ingredient I have, replacing any previous figure for it.
  Rejects "BAD_UNIT" for a unit outside the list above, and "INVALID_QUANTITY" for a negative or
  non-finite quantity.

- defineRecipe({ recipeId: string, name: string, servings: integer > 0,
  ingredients: Array<{ ingredient: string, quantity: number, unit: string }> })
  -> { ok: true } | { ok: false, error: string }
  The quantities are what the recipe needs for exactly \`servings\` people.
  Rejects "DUPLICATE_RECIPE", "BAD_UNIT", and "INVALID_SERVINGS".

- shoppingList({ recipeId: string, servings: integer > 0 })
  -> { ok: true, items: Array<{ ingredient: string, quantity: number, unit: string }> }
   | { ok: false, error: string }
  Scale the recipe from its own servings to the servings I ask for, subtract what is in stock, and
  return only the ingredients I am actually short of — never a zero or negative row. Report each
  shortfall in the unit the recipe uses, not the unit the pantry uses.
  Rejects "UNKNOWN_RECIPE", "INVALID_SERVINGS", and "INCOMPATIBLE_UNITS" when an ingredient's
  pantry unit belongs to a different family than the recipe's.`,
    verify: async verifier => {
      await verifier.check("scales-a-recipe-and-subtracts-matching-stock", async () => {
        using api = await verifier.connect<KitchenApi>("Kitchen");
        const defined = OkSchema.parse(await api.defineRecipe({
          recipeId: "loaf",
          name: "Sourdough loaf",
          servings: 2,
          ingredients: [
            { ingredient: "flour", quantity: 500, unit: "g" },
            { ingredient: "water", quantity: 300, unit: "ml" },
            { ingredient: "salt", quantity: 2, unit: "tsp" },
          ],
        }));
        // Enough flour for the doubled recipe, some water, no salt at all.
        await api.setStock({ ingredient: "flour", quantity: 1, unit: "kg" });
        await api.setStock({ ingredient: "water", quantity: 100, unit: "ml" });
        const list = ShoppingListSchema.parse(await api.shoppingList({ recipeId: "loaf", servings: 4 }));
        if (!list.ok) return { pass: false, evidence: list };
        return {
          pass: OkSchema.parse(defined).ok &&
            // 1000 g needed against 1 kg in stock is exactly covered, so flour must not appear.
            shortfall(list, "flour") === undefined &&
            near(shortfall(list, "water")?.quantity, 500) &&
            shortfall(list, "water")?.unit === "ml" &&
            near(shortfall(list, "salt")?.quantity, 4) &&
            shortfall(list, "salt")?.unit === "tsp" &&
            list.items.length === 2,
          evidence: list,
        };
      });

      await verifier.check("converts-across-units-within-a-family", async () => {
        using api = await verifier.connect<KitchenApi>("Kitchen");
        await api.defineRecipe({
          recipeId: "cake",
          name: "Butter cake",
          servings: 1,
          ingredients: [
            { ingredient: "butter", quantity: 300, unit: "g" },
            { ingredient: "cream", quantity: 2, unit: "cup" },
          ],
        });
        // Half a pound of butter is 226.796185 g, so 73.203815 g short of 300.
        await api.setStock({ ingredient: "butter", quantity: 0.5, unit: "lb" });
        // 360 ml of cream against 2 cups (480 ml) leaves 120 ml, which is half a cup.
        await api.setStock({ ingredient: "cream", quantity: 360, unit: "ml" });
        const list = ShoppingListSchema.parse(await api.shoppingList({ recipeId: "cake", servings: 1 }));
        if (!list.ok) return { pass: false, evidence: list };
        return {
          pass: near(shortfall(list, "butter")?.quantity, 73.204) &&
            shortfall(list, "butter")?.unit === "g" &&
            near(shortfall(list, "cream")?.quantity, 0.5) &&
            shortfall(list, "cream")?.unit === "cup",
          evidence: list,
        };
      });

      await verifier.check("refuses-to-convert-between-unit-families", async () => {
        using api = await verifier.connect<KitchenApi>("Kitchen");
        await api.defineRecipe({
          recipeId: "soup",
          name: "Soup",
          servings: 1,
          ingredients: [{ ingredient: "stock-liquid", quantity: 500, unit: "ml" }],
        });
        await api.setStock({ ingredient: "stock-liquid", quantity: 1, unit: "kg" });
        const list = ShoppingListSchema.parse(await api.shoppingList({ recipeId: "soup", servings: 1 }));
        return {
          pass: !list.ok && list.error === "INCOMPATIBLE_UNITS",
          evidence: list,
        };
      });

      await verifier.check("counts-whole-items-separately-from-mass", async () => {
        using api = await verifier.connect<KitchenApi>("Kitchen");
        await api.defineRecipe({
          recipeId: "omelette",
          name: "Omelette",
          servings: 2,
          ingredients: [{ ingredient: "egg", quantity: 3, unit: "unit" }],
        });
        await api.setStock({ ingredient: "egg", quantity: 2, unit: "unit" });
        // Six eggs for four people, two in the pantry, so four short.
        const list = ShoppingListSchema.parse(
            await api.shoppingList({ recipeId: "omelette", servings: 4 }));
        if (!list.ok) return { pass: false, evidence: list };
        return {
          pass: near(shortfall(list, "egg")?.quantity, 4) &&
            shortfall(list, "egg")?.unit === "unit",
          evidence: list,
        };
      });

      await verifier.check("rejects-bad-input-with-named-codes", async () => {
        using api = await verifier.connect<KitchenApi>("Kitchen");
        const rejections = {
          BAD_UNIT: OkSchema.parse(
              await api.setStock({ ingredient: "pepper", quantity: 1, unit: "pinch" })),
          INVALID_QUANTITY: OkSchema.parse(
              await api.setStock({ ingredient: "pepper", quantity: -1, unit: "g" })),
          DUPLICATE_RECIPE: OkSchema.parse(await api.defineRecipe({
            recipeId: "loaf", name: "Another loaf", servings: 1,
            ingredients: [{ ingredient: "flour", quantity: 1, unit: "g" }],
          })),
          INVALID_SERVINGS: OkSchema.parse(await api.defineRecipe({
            recipeId: "bad-servings", name: "Nothing", servings: 0,
            ingredients: [{ ingredient: "flour", quantity: 1, unit: "g" }],
          })),
        };
        const unknown = ShoppingListSchema.parse(
            await api.shoppingList({ recipeId: "no-such-recipe", servings: 1 }));
        const wrong = Object.entries(rejections)
            .filter(([code, result]) => result.ok || result.error !== code)
            .map(([code, result]) => ({ expected: code, got: result }));
        return {
          pass: wrong.length === 0 && !unknown.ok && unknown.error === "UNKNOWN_RECIPE",
          evidence: { wrong, unknown },
        };
      });
    },
  }],
});
