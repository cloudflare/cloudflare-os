import { afterAll, describe, expect, it } from "vitest";
import { closeViewBrowser, RenderedView } from "./view-host.js";

afterAll(() => closeViewBrowser());

describe("RenderedView", { timeout: 60_000 }, () => {
  it("runs a view and records what it asks to send", async () => {
    await using view = await RenderedView.open(`
      <p id="total"></p>
      <button id="ask">Ask</button>
      <script type="module">
        document.getElementById("total").textContent = "Food 420";
        document.getElementById("ask").onclick = () => agent.send("Show me food");
      </script>`);
    expect(await view.text()).toContain("Food 420");
    await view.click("Ask", []);
    expect(view.messages).toEqual(["Show me food"]);
    expect(view.unsettled).toBeUndefined();
  });

  it("records errors, blocked requests and markup parsed from strings, which throws", async () => {
    await using view = await RenderedView.open(`
      <div id="out"></div>
      <img src="https://example.com/chart.png">
      <script type="module">
        fetch("https://example.com/api").catch(() => {});
        new WebSocket("wss://example.com/socket");
        Promise.reject(new Error("rejected"));
        const out = document.getElementById("out");
        out.innerHTML = "";
        out.innerHTML = "<b>Food</b>";
      </script>`);
    await expect.poll(() => view.requests.toSorted()).toEqual([
      "https://example.com/api", "https://example.com/chart.png", "wss://example.com/socket",
    ]);
    await expect.poll(() => view.errors.toSorted())
        .toEqual([expect.stringMatching(/requires 'TrustedHTML'/), "rejected"]);
    expect(view.markup).toEqual(["innerHTML: <b>Food</b>"]);
  });

  it("clicks a chart bar through its label, once", async () => {
    await using view = await RenderedView.open(`
      <svg width="300" height="140">
        <rect id="food" x="0" y="0" width="100" height="100" />
        <rect id="travel" x="150" y="0" width="100" height="100" />
        <text x="30" y="125">Food</text>
        <text x="180" y="125">Travel</text>
      </svg>
      <script type="module">
        for (const id of ["food", "travel"]) {
          document.getElementById(id).addEventListener("click", () => agent.send("About " + id));
        }
      </script>`);
    await view.click("Travel", ["Food"]);
    expect(view.messages).toEqual(["About travel"]);
  });

  it("ticks the checkbox in an item's row and stops at the first message", async () => {
    await using view = await RenderedView.open(`
      <ul>
        <li><input type="checkbox" data-title="Dune"> <span>Dune</span></li>
        <li><input type="checkbox" data-title="Piranesi"> <span>Piranesi</span> <button>Remove</button></li>
      </ul>
      <script type="module">
        for (const box of document.querySelectorAll("input")) {
          box.addEventListener("change", () => agent.send("Read " + box.dataset.title));
        }
        document.querySelector("button").addEventListener("click", () => agent.send("Remove it"));
      </script>`);
    await view.click("Piranesi", ["Dune"]);
    expect(view.messages).toEqual(["Read Piranesi"]);
  });

  it("changes a value through the control holding it, or its stepper", async () => {
    await using input = await RenderedView.open(`
      <label>People <input id="people" type="number" value="4"></label>
      <p id="each"></p>
      <script type="module">
        const people = document.getElementById("people");
        const show = () => {
          document.getElementById("each").textContent = "Each " + (100 / Number(people.value)).toFixed(2);
        };
        people.addEventListener("change", show);
        show();
      </script>`);
    expect(await input.setValue("4", "5", text => text.includes("Each 20.00")))
      .toMatchObject({ pass: true, how: "changed the control holding 4" });

    await using stepper = await RenderedView.open(`
      <span id="people">4</span> <button aria-label="Add a person">+</button>
      <p id="each"></p>
      <script type="module">
        let people = 4;
        const show = () => {
          document.getElementById("people").textContent = people;
          document.getElementById("each").textContent = "Each " + (100 / people).toFixed(2);
        };
        document.querySelector("button").onclick = () => { people++; show(); };
        show();
      </script>`);
    expect(await stepper.setValue("4", "5", text => text.includes("Each 20.00")))
      .toMatchObject({ pass: true, how: "clicked its stepper 1 times" });
  });
});
