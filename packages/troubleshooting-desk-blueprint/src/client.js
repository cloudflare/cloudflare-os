const gadget = globalThis.gadget;

const style = `
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f4f7fb;
  color: #172235;
  --ink: #172235;
  --muted: #66748a;
  --line: #dbe3ee;
  --card: #ffffff;
  --blue: #2463eb;
  --blue-soft: #edf3ff;
  --green: #14805e;
  --green-soft: #eaf8f2;
  --amber: #946200;
  --amber-soft: #fff5dc;
  --red: #b33944;
  --red-soft: #fff0f1;
  --shadow: 0 16px 40px rgba(38, 60, 91, .08);
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: #f4f7fb; }
button, input, select, textarea { font: inherit; }
button { cursor: pointer; }
.shell { max-width: 1440px; margin: 0 auto; padding: 30px 34px 44px; }
.masthead { display: flex; justify-content: space-between; align-items: flex-start; gap: 28px; margin-bottom: 22px; }
.eyebrow { color: var(--blue); font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
h1 { margin: 7px 0 8px; font-size: clamp(30px, 4vw, 46px); line-height: 1.04; letter-spacing: -.045em; }
.lede { max-width: 720px; margin: 0; color: var(--muted); font-size: 15px; line-height: 1.55; }
.scope-note { min-width: 244px; padding: 15px 17px; border: 1px solid #cfe0ff; border-radius: 14px; background: var(--blue-soft); color: #29509b; font-size: 12px; line-height: 1.45; }
.scope-note strong { display: block; color: #17439b; margin-bottom: 4px; }
.layout { display: grid; grid-template-columns: 325px minmax(0, 1fr); gap: 20px; align-items: start; }
.card { border: 1px solid var(--line); border-radius: 16px; background: var(--card); box-shadow: var(--shadow); }
.card-header { padding: 20px 21px 0; }
.card-header h2, .card-header h3 { margin: 0; font-size: 16px; letter-spacing: -.01em; }
.card-header p { margin: 7px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.form { padding: 19px 21px 21px; }
.field { margin-bottom: 14px; }
.field label { display: block; margin-bottom: 6px; color: #42516a; font-size: 12px; font-weight: 700; }
.field input, .field select, .field textarea { width: 100%; border: 1px solid #cbd6e4; border-radius: 9px; padding: 10px 11px; color: var(--ink); background: #fff; outline: none; }
.field textarea { min-height: 76px; resize: vertical; line-height: 1.4; }
.field input:focus, .field select:focus, .field textarea:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(36, 99, 235, .12); }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.button { display: inline-flex; justify-content: center; align-items: center; gap: 7px; border: 0; border-radius: 9px; padding: 10px 13px; font-size: 12px; font-weight: 800; transition: transform .15s, box-shadow .15s, background .15s; }
.button:hover { transform: translateY(-1px); }
.button:disabled { opacity: .55; cursor: wait; transform: none; }
.button.primary { width: 100%; color: white; background: var(--blue); box-shadow: 0 6px 14px rgba(36, 99, 235, .2); }
.button.secondary { color: #2251ad; background: var(--blue-soft); }
.button.ghost { color: #53627a; background: #f1f4f8; }
.button.warning { color: #7d5100; background: var(--amber-soft); }
.case-list { margin-top: 20px; overflow: hidden; }
.case-list-header { display: flex; justify-content: space-between; align-items: center; padding: 17px 18px 12px; border-bottom: 1px solid var(--line); }
.case-list-header h3 { margin: 0; font-size: 14px; }
.case-count { color: var(--muted); font-size: 11px; }
.cases { padding: 7px; }
.case-row { display: block; width: 100%; padding: 12px 11px; border: 0; border-radius: 10px; background: transparent; text-align: left; }
.case-row:hover, .case-row.active { background: #f0f5ff; }
.case-row strong { display: block; overflow: hidden; color: var(--ink); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.case-row span { display: block; margin-top: 5px; overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.empty { padding: 16px 12px 18px; color: var(--muted); font-size: 12px; line-height: 1.5; }
.detail { min-width: 0; }
.welcome { min-height: 520px; display: grid; place-items: center; padding: 44px; text-align: center; }
.welcome-inner { max-width: 550px; }
.welcome-mark { display: inline-grid; place-items: center; width: 58px; height: 58px; border-radius: 18px; color: var(--blue); background: var(--blue-soft); font-size: 26px; font-weight: 900; }
.welcome h2 { margin: 18px 0 9px; font-size: 25px; letter-spacing: -.03em; }
.welcome p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.6; }
.case-heading { padding: 24px 25px 20px; border-bottom: 1px solid var(--line); }
.case-heading-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.case-heading h2 { margin: 5px 0 7px; font-size: clamp(20px, 3vw, 28px); letter-spacing: -.035em; }
.case-heading p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.heading-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 5px 8px; font-size: 10px; font-weight: 800; letter-spacing: .02em; text-transform: uppercase; }
.pill.simulated { color: #795000; background: var(--amber-soft); }
.pill.inspected { color: var(--green); background: var(--green-soft); }
.pill.open { color: #2754a5; background: var(--blue-soft); }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding: 18px 25px; border-bottom: 1px solid var(--line); }
.summary-item { min-width: 0; padding: 12px 13px; border: 1px solid var(--line); border-radius: 11px; background: #fbfcfe; }
.summary-item label { display: block; color: var(--muted); font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.summary-item strong { display: block; margin-top: 6px; overflow: hidden; color: var(--ink); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.summary-item.divergence { border-color: #f1d6a0; background: #fffbf0; }
.summary-item.divergence strong { color: #885800; }
.section { padding: 21px 25px; border-bottom: 1px solid var(--line); }
.section:last-child { border-bottom: 0; }
.section-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.section-title h3 { margin: 0; font-size: 15px; letter-spacing: -.015em; }
.section-title span { color: var(--muted); font-size: 11px; }
.fact-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; }
.fact-box { padding: 14px; border-radius: 11px; }
.fact-box.confirmed { background: var(--green-soft); }
.fact-box.unresolved { background: #fff8e8; }
.fact-box h4 { margin: 0 0 9px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.fact-box.confirmed h4 { color: var(--green); }
.fact-box.unresolved h4 { color: var(--amber); }
.fact-box ul { margin: 0; padding-left: 17px; color: #42516a; font-size: 12px; line-height: 1.55; }
.next-action { padding: 14px 15px; border-left: 3px solid var(--blue); border-radius: 0 10px 10px 0; background: var(--blue-soft); color: #234688; font-size: 13px; line-height: 1.5; }
.ladder { display: grid; gap: 9px; }
.evidence { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.evidence summary { display: flex; align-items: center; gap: 10px; padding: 13px 14px; cursor: pointer; list-style: none; }
.evidence summary::-webkit-details-marker { display: none; }
.evidence summary:hover { background: #fafcff; }
.step { display: inline-grid; place-items: center; flex: 0 0 auto; width: 24px; height: 24px; border-radius: 8px; color: #34517f; background: #e9eef7; font-size: 11px; font-weight: 900; }
.evidence-name { min-width: 0; flex: 1; font-size: 13px; font-weight: 800; }
.verdict { flex: 0 0 auto; border-radius: 999px; padding: 4px 7px; font-size: 10px; font-weight: 900; text-transform: uppercase; }
.verdict.matches { color: var(--green); background: var(--green-soft); }
.verdict.mismatch, .verdict.missing { color: var(--red); background: var(--red-soft); }
.verdict.inconclusive { color: var(--amber); background: var(--amber-soft); }
.evidence-body { padding: 0 14px 15px 48px; }
.evidence-observation { margin: 0 0 12px; color: #42516a; font-size: 12px; line-height: 1.5; }
.evidence-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.meta-block { min-width: 0; padding: 10px; border: 1px solid #e5eaf1; border-radius: 9px; background: #fbfcfe; }
.meta-block label { display: block; margin-bottom: 5px; color: var(--muted); font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.meta-block code, .meta-block pre { display: block; margin: 0; overflow: auto; color: #35455f; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
.history { display: grid; gap: 8px; }
.history-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 9px; color: #42516a; font-size: 11px; }
.history-row strong { color: var(--ink); font-size: 12px; }
.action-form { display: flex; align-items: end; gap: 10px; }
.action-form .field { flex: 1; margin: 0; }
.action-note { margin: 10px 0 0; color: var(--muted); font-size: 11px; line-height: 1.45; }
.approval { margin-top: 12px; padding: 13px; border: 1px solid #f0d18f; border-radius: 10px; background: #fffaf0; color: #7d5100; font-size: 12px; line-height: 1.5; }
.error { margin: 12px 25px 0; padding: 11px 13px; border-radius: 9px; color: var(--red); background: var(--red-soft); font-size: 12px; }
@media (max-width: 920px) { .layout { grid-template-columns: 1fr; } .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .masthead { display: block; } .scope-note { margin-top: 18px; } }
@media (max-width: 570px) { .shell { padding: 22px 14px 32px; } .summary-grid, .fact-columns, .evidence-meta { grid-template-columns: 1fr; } .case-heading-top { display: block; } .heading-actions { justify-content: flex-start; margin-top: 15px; } .action-form { display: block; } .action-form .button { width: 100%; margin-top: 9px; } }
@media print { body { background: white; } .shell { max-width: none; padding: 0; } .masthead, aside, .heading-actions, .action-form, .action-note { display: none !important; } .layout { display: block; } .card { border: 0; box-shadow: none; } .section, .case-heading, .summary-grid { break-inside: avoid; } .evidence { break-inside: avoid; } .evidence[open] { display: block; } }
`;

document.head.appendChild(Object.assign(document.createElement("style"), { textContent: style }));

const state = { cases: [], current: null, error: "", busy: false };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function localDateTime(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}T${padNumber(date.getHours())}:${padNumber(date.getMinutes())}`;
}

function padNumber(number) {
  return String(number).padStart(2, "0");
}

function listFacts(title, facts) {
  return `<div class="fact-box ${title === "Confirmed facts" ? "confirmed" : "unresolved"}"><h4>${escapeHtml(title)}</h4><ul>${(facts?.length ? facts : ["—"]).map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul></div>`;
}

function evidenceCard(item, index) {
  const source = item.source ?? {};
  const scope = item.scope ?? {};
  return `<details class="evidence" ${item.verdict === "mismatch" || item.verdict === "missing" ? "open" : ""}>
    <summary><span class="step">${index + 1}</span><span class="evidence-name">${escapeHtml(item.boundary)}</span><span class="verdict ${escapeHtml(item.verdict)}">${escapeHtml(item.verdict)}</span></summary>
    <div class="evidence-body">
      <p class="evidence-observation">${escapeHtml(item.observation)}</p>
      <div class="evidence-meta">
        <div class="meta-block"><label>Source locator</label><code>system: ${escapeHtml(source.system)}</code><code>locator: ${escapeHtml(source.locator)}</code><code>query: ${escapeHtml(source.query ?? "—")}</code><code>run: ${escapeHtml(source.run ?? "—")}</code><code>key: ${escapeHtml(source.key ?? "—")}</code><code>endpoint: ${escapeHtml(source.endpoint ?? "—")}</code></div>
        <div class="meta-block"><label>Observation</label><code>${escapeHtml(item.observedAt)}</code><code>${escapeHtml(scope.plantId)} · ${escapeHtml(scope.from)} → ${escapeHtml(scope.to)}</code><code>${escapeHtml(scope.timeZone)} · ${escapeHtml((scope.deviceIds ?? []).join(", "))}</code></div>
        <div class="meta-block"><label>Immutable snapshot</label><code>${escapeHtml(item.snapshot?.reference)}</code><code>fingerprint: ${escapeHtml(item.snapshot?.fingerprint)}</code><pre>${escapeHtml(JSON.stringify(item.snapshot?.value, null, 2))}</pre></div>
        <div class="meta-block"><label>Freshness</label><code>${escapeHtml(item.freshness?.state)}</code><code>${escapeHtml(item.freshness?.policy)}</code></div>
      </div>
    </div>
  </details>`;
}

function currentSummary(record) {
  return `<div class="summary-grid">
    <div class="summary-item"><label>Plant</label><strong>${escapeHtml(record.input.plantId)}</strong></div>
    <div class="summary-item"><label>Plant-local scope</label><strong>${escapeHtml(record.input.timeRange.from)} → ${escapeHtml(record.input.timeRange.to)}</strong></div>
    <div class="summary-item"><label>Runbook state</label><strong>${escapeHtml(record.status)}</strong></div>
    <div class="summary-item divergence"><label>First divergence</label><strong>${escapeHtml(record.firstDivergentBoundary ?? "Not established")}</strong></div>
  </div>`;
}

function renderCase(record) {
  const latest = record.observations?.[record.observations.length - 1];
  const proposals = record.proposals ?? [];
  return `<section class="card">
    <div class="case-heading"><div class="case-heading-top"><div><div class="eyebrow">Investigation case · ${escapeHtml(record.id.slice(0, 17))}</div><h2>${escapeHtml(record.input.symptom)}</h2><p>${escapeHtml(record.input.plantId)} · ${escapeHtml(record.input.timeRange.timeZone)} · opened ${escapeHtml(formatTime(record.createdAt))}</p></div><div class="heading-actions"><span class="pill ${escapeHtml(record.status)}">${escapeHtml(record.status)}</span><span class="pill simulated">${escapeHtml(record.integration)} adapter</span><button class="button secondary" data-action="${latest ? "revisit" : "inspect"}">${latest ? "Refresh evidence" : "Run read-only inspection"}</button></div></div></div>
    ${currentSummary(record)}
    ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ""}
    ${latest ? `<div class="section"><div class="section-title"><h3>Finding</h3><span>latest observation ${escapeHtml(formatTime(latest.inspectedAt))}</span></div><div class="fact-columns">${listFacts("Confirmed facts", latest.confirmedFacts)}${listFacts("Unresolved facts", latest.unresolvedFacts)}</div><div class="next-action" style="margin-top: 13px"><strong>Safe next action</strong><br>${escapeHtml(latest.safeNextAction)}</div></div>
      <div class="section"><div class="section-title"><h3>Evidence ladder</h3><span>${latest.evidence.length} boundaries · append-only snapshot</span></div><div class="ladder">${latest.evidence.map(evidenceCard).join("")}</div></div>
      <div class="section"><div class="section-title"><h3>Observation history</h3><span>old snapshots stay visible</span></div><div class="history">${record.observations.toReversed().map((observation) => `<div class="history-row"><span><strong>${escapeHtml(observation.id.slice(0, 25))}</strong><br>${escapeHtml(observation.firstDivergentBoundary ?? "No divergence established")}</span><span>${escapeHtml(formatTime(observation.inspectedAt))}</span></div>`).join("")}</div></div>`
      : `<div class="section"><div class="next-action"><strong>Ready for inspection</strong><br>${escapeHtml(record.safeNextAction)}</div></div>`}
    <div class="section"><div class="section-title"><h3>Prepare an action</h3><span>never runs automatically</span></div><form class="action-form" id="action-form"><div class="field"><label for="action-type">Proposed action</label><select id="action-type" name="type"><option value="review-mapping">Review effective mapping</option><option value="request-backfill">Request a scoped backfill</option><option value="repair-cache">Prepare a cache repair</option><option value="verify-deployment">Verify deployment identity</option></select></div><button class="button warning" type="submit">Prepare for approval</button></form><p class="action-note">This creates an approval request only. Any mutation needs separate human approval and post-action durable-output verification.</p>${proposals.map((proposal) => `<div class="approval"><strong>Prepared · ${escapeHtml(proposal.action.type)}</strong><br>${escapeHtml(proposal.note)}<br><small>${escapeHtml(formatTime(proposal.createdAt))}</small></div>`).join("")}</div>
  </section>`;
}

function render() {
  const caseRows = state.cases.length
    ? state.cases.map((item) => `<button class="case-row ${state.current?.id === item.id ? "active" : ""}" data-case-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.plantId)} · ${escapeHtml(item.symptom)}</strong><span>${escapeHtml(item.firstDivergentBoundary ?? item.status)} · ${escapeHtml(item.observationCount)} observation${item.observationCount === 1 ? "" : "s"}</span></button>`).join("")
    : `<div class="empty">No cases yet. Open a scoped investigation to create the first durable record.</div>`;
  const detail = state.current ? renderCase(state.current) : `<section class="card welcome"><div class="welcome-inner"><span class="welcome-mark">⌁</span><h2>Start with a bounded question</h2><p>Open a case with the exact Plant-local scope and symptom. The named daily-grid runbook will keep each evidence boundary and its limits visible.</p></div></section>`;
  const globalError = state.error && !state.current ? `<div class="error">${escapeHtml(state.error)}</div>` : "";
  document.body.innerHTML = `<div class="shell"><header class="masthead"><div><div class="eyebrow">AVA / Read-only runbook console</div><h1>Troubleshooting Desk</h1><p class="lede">Turn a wrong, blank, or reversed Plant Overview daily grid value into a revisitable evidence-led case.</p></div><div class="scope-note"><strong>Simulation boundary</strong>The bundled adapter is local and read-only. Live AVA telemetry, configuration, Dagster, cache, API, and chart capabilities are deferred.</div></header>${globalError}<div class="layout"><aside><section class="card"><div class="card-header"><h2>Open a case</h2><p>Use Plant-local time. Do not infer the scope from browser UTC.</p></div><form class="form" id="case-form"><div class="field"><label for="plant-id">Plant</label><input id="plant-id" name="plantId" required placeholder="e.g. nam-phat"></div><div class="field"><label>Plant-local time range</label><div class="split"><input name="from" type="datetime-local" required value="${escapeHtml(localDateTime(-1))}"><input name="to" type="datetime-local" required value="${escapeHtml(localDateTime())}"></div></div><div class="field"><label for="time-zone">Plant time zone</label><input id="time-zone" name="timeZone" required value="${escapeHtml(Intl.DateTimeFormat().resolvedOptions().timeZone)}" placeholder="Asia/Ho_Chi_Minh"></div><div class="field"><label for="symptom">Symptom</label><textarea id="symptom" name="symptom" required placeholder="Plant Overview daily grid value is wrong, blank, or reversed"></textarea></div><div class="field"><label for="affected-output">Affected output <span style="font-weight:400;color:var(--muted)">(optional)</span></label><select id="affected-output" name="affectedOutput"><option value="">Not specified</option><option value="chart">Chart</option><option value="csv">CSV</option><option value="report">Report</option><option value="cache">Cache</option><option value="api">API</option></select></div><button class="button primary" type="submit">Open case</button></form></section><section class="card case-list"><div class="case-list-header"><h3>Recent cases</h3><span class="case-count">${state.cases.length}</span></div><div class="cases">${caseRows}</div></section></aside><main class="detail">${detail}</main></div></div>`;
  document.querySelector("#case-form")?.addEventListener("submit", openCase);
  document.querySelectorAll("[data-case-id]").forEach((button) => button.addEventListener("click", () => selectCase(button.dataset.caseId)));
  document.querySelector("[data-action]")?.addEventListener("click", runInspection);
  document.querySelector("#action-form")?.addEventListener("submit", prepareAction);
}

async function withBusy(work) {
  state.busy = true;
  state.error = "";
  render();
  try {
    await work();
  } catch (error) {
    state.error = error instanceof Error ? error.message : "The operation failed.";
  } finally {
    state.busy = false;
    render();
  }
}

async function openCase(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await withBusy(async () => {
    const input = {
      plantId: form.get("plantId"),
      timeRange: { from: form.get("from"), to: form.get("to"), timeZone: form.get("timeZone") },
      symptom: form.get("symptom"),
      ...(form.get("affectedOutput") ? { affectedOutput: form.get("affectedOutput") } : {}),
    };
    state.current = await gadget.open(input);
    await refreshCases();
  });
}

async function refreshCases() {
  state.cases = await gadget.listCases();
}

async function selectCase(caseId) {
  await withBusy(async () => { state.current = await gadget.getCase(caseId); });
}

async function runInspection(event) {
  const mode = event.currentTarget.dataset.action;
  if (!state.current) return;
  await withBusy(async () => {
    state.current = mode === "revisit"
      ? await gadget.revisit(state.current.id)
      : await gadget.inspect(state.current.id, { runbook: "daily-grid", mode: "read-only" });
    await refreshCases();
  });
}

async function prepareAction(event) {
  event.preventDefault();
  if (!state.current) return;
  const type = new FormData(event.currentTarget).get("type");
  await withBusy(async () => {
    await gadget.proposeAction(state.current.id, { type });
    state.current = await gadget.getCase(state.current.id);
    await refreshCases();
  });
}

try {
  await refreshCases();
} catch (error) {
  state.error = error instanceof Error ? error.message : "The case list could not be loaded.";
}
render();
