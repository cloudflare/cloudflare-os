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

  it("records errors and blocked requests", async () => {
    await using view = await RenderedView.open(`
      <link rel="stylesheet" href="https://example.com/style.css">
      <img src="https://example.com/chart.png">
      <div style="width:10px;height:10px;background:url(https://example.com/tile.png)"></div>
      <iframe src="https://example.com/embed"></iframe>
      <script type="module" src="https://example.com/app.js"></script>
      <script type="module">
        fetch("https://example.com/api").catch(() => {});
        new WebSocket("wss://example.com/socket");
        Promise.reject(new Error("rejected"));
      </script>`);
    await expect.poll(() => view.requests.toSorted()).toEqual([
      "https://example.com/api", "https://example.com/app.js", "https://example.com/chart.png",
      "https://example.com/embed", "https://example.com/style.css", "https://example.com/tile.png",
      "wss://example.com/socket",
    ]);
    await expect.poll(() => view.errors).toEqual(["rejected"]);
  });

  it("runs a view under the Workshop frame's script rules", async () => {
    await using view = await RenderedView.open(`
      <p id="out"></p>
      <button onclick="agent.send('Clicked')">Ask</button>
      <script type="module">
        const tries = [
          () => eval("1"),
          () => new Function("return 1")(),
          () => import(URL.createObjectURL(new Blob(["export default 1"], { type: "text/javascript" }))),
          () => import("data:text/javascript,export default 1"),
          () => WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
        ];
        const results = await Promise.all(tries.map(async run => { try { await run(); return "ran"; } catch { return "refused"; } }));
        document.getElementById("out").textContent = results.join(" ");
      </script>`);
    expect((await view.waitForText(text => text.includes("ran"))).text).toContain("refused refused refused ran ran");
    await view.click("Ask", []);
    expect(view.messages).toEqual(["Clicked"]);
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
      .toMatchObject({ pass: true, how: "changed the control and pressed Enter" });

    await using stepper = await RenderedView.open(`
      <span id="people">4</span><button aria-label="Add a person">+</button>
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

  it("clicks a control only where nothing covers it", async () => {
    const view = (style: string) => RenderedView.open(`
      <div style="position:relative">
        <button id="pick" style="width:200px;height:40px">Pick</button>
        <div style="position:absolute;top:0;left:0;${style};height:40px;background:#eee">Streamer</div>
      </div>
      <script type="module">
        document.getElementById("pick").addEventListener("click", () => agent.send("Pick Streamer"));
      </script>`);
    await using covered = await view("width:200px");
    expect(await covered.click("Streamer", [])).toContain('found nothing to click on button#pick "pick"');
    expect(covered.messages).toEqual([]);
    await using half = await view("width:120px");
    await half.click("Streamer", []);
    expect(half.messages).toEqual(["Pick Streamer"]);

    await using inert = await RenderedView.open(`
      <button style="pointer-events:none"><span>Streamer</span></button>
      <script type="module">
        document.querySelector("button").addEventListener("click", () => agent.send("Pick Streamer"));
      </script>`);
    await inert.click("Streamer", []);
    expect(inert.messages).toEqual([]);
  });

  it("edits only a control the user can see and change, within its limits", async () => {
    const view = (attributes: string) => RenderedView.open(`
      <input id="people" value="4" ${attributes}> <p id="each"></p>
      <script type="module">
        const people = document.getElementById("people");
        const show = () => { document.getElementById("each").textContent = "People " + people.value; };
        people.addEventListener("input", show);
        show();
      </script>`);
    for (const attributes of ["readonly", "disabled", 'style="opacity:0"', 'style="position:absolute;left:-9999px"']) {
      await using refused = await view(attributes);
      expect(await refused.setValue("4", "5", text => text.includes("People 5")), attributes)
        .toMatchObject({ pass: false, how: "found no control holding 4" });
    }
    await using limited = await view('maxlength="1"');
    const limitedEdit = await limited.setValue("4", "12", text => text.includes("People 1"));
    expect(limitedEdit.pass).toBe(true);
    expect(limitedEdit.text).not.toContain("12");

    await using select = await RenderedView.open(`
      <select id="people"><option>4</option><option>5</option></select> <p id="each"></p>
      <script type="module">
        const people = document.getElementById("people");
        people.addEventListener("change", () => { document.getElementById("each").textContent = "People " + people.value; });
      </script>`);
    expect(await select.setValue("4", "5", text => text.includes("People 5"))).toMatchObject({ pass: true });
  });

  it("reads the space between inline elements, and none where they touch", async () => {
    await using view = await RenderedView.open(`<div><span>Jan</span> <span>410</span></div><div><b>Feb</b>\n  <i>380</i></div>
      <p><span style="display:inline-block">$54</span><span style="display:inline-block">.46</span></p><pre>Mar\n340</pre>`);
    expect(await view.text()).toBe("Jan 410\nFeb 380\n$54.46\nMar\n340");
  });

  it("reads text that elements split as one reading, not as its parts", async () => {
    await using view = await RenderedView.open(`
      <p>Each pays <span>$<b>4</b><small>.50</small></span> <button aria-label="Add a person">+</button></p>
      <p><b>Stream</b>er $45 · <b>Basic</b> $15</p>`);
    expect((await view.shownTexts()).map(({ text }) => text).toSorted())
      .toEqual(["$4.50", "+", "Basic", "Each pays $4.50 +", "Streamer $45 · Basic $15"]);
    const { series } = await view.waitForSeries(["Streamer", "Basic"], () => true);
    expect(series.beside).toEqual([expect.stringContaining("$45"), expect.stringContaining("$15")]);
    expect(series.beside[0]).not.toContain("$15");
    expect(await view.setValue("4", "5", text => text.includes("$5"))).toMatchObject({ pass: false, how: "found no control holding 4" });
  });

  it("reads the values a person sees in form controls", async () => {
    await using view = await RenderedView.open(`
      <p>Each <input value="$54.46" readonly> or <input value="$43.57" disabled></p>
      <textarea>A note</textarea> <input type="submit" value="Split">
      <input value="hidden away" style="visibility:hidden"> <input type="hidden" value="secret">
      <input type="password" value="hunter2"> <input type="checkbox" value="on"> <input placeholder="Type here">`);
    expect((await view.text()).split("\n")).toEqual(["Each $54.46 or $43.57", "A note Split"]);
  });

  it("reads only text a person can see", async () => {
    await using view = await RenderedView.open(`
      <p>Shown <span style="opacity:0">faded</span> <span style="visibility:hidden">hidden</span></p>
      <p style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">screen reader</p>
      <p style="position:absolute;left:-9999px">off the page</p>
      <p style="font-size:1px">tiny</p>
      <svg width="100" height="40"><rect width="50" height="20" aria-label="Bar"><title>Tooltip</title></rect>
        <rect width="50" height="20" opacity="0" aria-label="Unseen bar" /></svg>`);
    expect((await view.text()).split("\n")).toEqual(["Shown", "Bar", "Tooltip"]);

    await using blank = await RenderedView.open(`<style>body { display: none; }</style><p>Jan 410</p><svg width="100" height="40"></svg>`);
    expect(await blank.text()).toBe("");
    expect(await blank.visible()).toBe(false);
  });

  it("pairs each label with what is shown beside it and the marks plotted for it", async () => {
    await using view = await RenderedView.open(`
      <ul><li><b>Food</b> <span>$420</span></li><li><b>Travel</b> <span>$185</span></li></ul>
      <svg width="200" height="120">
        <rect x="10" y="20" width="30" height="80" /><text x="25" y="115" text-anchor="middle">Jan</text>
        <rect x="60" y="60" width="30" height="40" /><text x="75" y="115" text-anchor="middle">Feb</text>
      </svg>`);
    const { series } = await view.waitForSeries(["Food", "Travel", "Jan", "Feb"], () => true);
    expect(series.beside.slice(0, 2)).toEqual([expect.stringContaining("$420"), expect.stringContaining("$185")]);
    expect(series.beside[0]).not.toContain("$185");
    expect(series.marks.filter(mark => mark.key === "rect 0"))
      .toEqual([{ label: 2, key: "rect 0", axis: "y", at: expect.any(Number) }, { label: 3, key: "rect 0", axis: "y", at: expect.any(Number) }]);
  });

  it("finds each label where it is drawn, in a box of its own beside another", async () => {
    for (const gap of ["", " "]) {
      await using view = await RenderedView.open(`
        <div style="display:flex;gap:60px;height:100px;align-items:flex-end">
          <div style="background:black;width:30px;height:80px"></div><div style="background:black;width:30px;height:40px"></div>
        </div>
        <div><span style="display:inline-block;width:90px">Jan</span>${gap}<span style="display:inline-block;width:90px">Feb</span></div>`);
      const { series } = await view.waitForSeries(["Jan", "Feb"], () => true);
      expect(series.marks.map(({ label, axis }) => [label, axis]), JSON.stringify(gap)).toEqual([[0, "y"], [1, "y"]]);
    }
  });
});
