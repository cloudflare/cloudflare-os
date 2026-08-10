# ForterOS ("ForterCIP — Trust Command Center") — Design Specification

**Date:** 2026-08-10
**Status:** Approved design, pending implementation plan
**Source of truth for visuals:** Claude Design project `3e3eb827-461a-44fe-8859-6632238c592d` (`ForterOS.html` + `os-*.jsx`), Forter design system bundle `forter-design-system-019e032b`.

---

## 1. Vision

ForterOS is Forter's **customer intelligence platform**: a visual-first **Trust Command Center** that turns Forter's network intelligence into a live, queryable, actionable product for merchant teams. Tagline: *"Know who to trust."*

It is explicitly **not a chat clone**. Three interaction models coexist:

1. **Visual-first command center (Pulse)** — KPIs, a live platform flow map, and user-curated boards of pinned insights.
2. **Ask anything (⌘K ask-bar + Chat)** — natural language over orders, identities, signals, and metrics, answered by structured tools with rich chart cards; every answer can be pinned or acted on.
3. **Identity dossier investigation (Investigate)** — one order, every signal Forter sees, with the power to feed decisions back to the network.

Everything runs on the same **agentic data layer**: six live MCP capabilities plus feedback tools, which customers can also wire into their own tools (Claude, Claude Code, ChatGPT, Copilot, Gemini, business apps).

### Implementation foundation

- **Fork of `cloudflare-os`** (this repository), rebranded and re-skinned. The upstream concepts map directly: workshop-backend = kernel, gatekeepers = connectors/capability enforcement, agents = ForterOS agents/jobs, frontend = the ForterCIP shell.
- **Self-hosted on `workerd`** (Forter-controlled infrastructure; note upstream tooling for this path is still maturing — the implementation plan must include the workerd deployment work).
- **Forter Portal MCP** (`https://portal.forter.com/mcp`) is wrapped as a **Gatekeeper** exposing the six capabilities + feedback tools.
- Sign-in via **Forter SSO**; all external connectors OAuth with least-privilege, revocable scopes.

---

## 2. Personas & role lenses

Four departments, eight personas. The active persona is a **lens**: it changes suggested questions, one-line takeaways on every answer card, and (nothing else — data is identical for all roles; access is governed separately in §8).

| Department | Persona | Lens key |
|---|---|---|
| Risk & Fraud | Risk Analyst | analyst |
| Risk & Fraud | Fraud Ops Manager | analyst |
| Customer Experience | CX Lead | cx |
| Customer Experience | Support Agent | cx |
| Finance & Payments | Finance Controller | finance |
| Finance & Payments | Payments Manager | finance |
| Trust & Safety | T&S Lead | trust |
| Trust & Safety | Policy Analyst | trust |

- The **RoleSwitcher** lives at the bottom of the sidebar ("Viewing as …", grouped by department; compact variant in the mobile "More" sheet).
- Every answer card renders a **RoleLens** line: e.g. for the approval-trend card, the analyst lens reads *"The Jul 7 dip tracks the fraud-ring pressure — check ring traffic before tuning"*, while the CX lens reads *"~2% of good-looking customers were declined Jul 7 — expect a bump in 'why was I declined' contacts."* Each of the 12 answer cards has one takeaway per lens (48 strings total; see design source `os-roles.jsx`).
- Switching roles fires a toast: *"Viewing as {role} — suggestions and takeaways adapt."* Persisted per user.

---

## 3. Capability inventory (the agentic data layer)

### 3.1 Core MCP capabilities ("6 capabilities live")

| Capability | What it does | Example asks |
|---|---|---|
| **Ask Orders** | NL over order data: KPIs, trends, aggregations | "approval rate last 7 days", "top declined reasons this week" |
| **Investigate Order** | Risk assessment + decision context + behavioral signals for ONE order; threaded follow-ups | "why was 40E018J declined", "other orders linked by device/email" |
| **Explain Order** | One-shot human-readable decision explanation | (param: orderId) |
| **Get Order By ID** | Raw structured fields: orderId, amountUSD, buyerEmail, decision, shipping/billingCountry, paymentMethod, orderStatus, platform, device, transactionTime | "where is order #A8842156" |
| **Ask Disputes** | NL over claims/disputes | "open disputes this month", "chargeback win rate" |
| **Request Decline** | Merchant flags fraud back to Forter; `confidence_level: not_sure \| high_confidence \| victim_confirmed` | via feedback wizard |

### 3.2 Feedback tools (wrapped by the guided feedback flow, §7.4)

- `can_submit_feedback` — eligibility gate (returns `canSubmit` + `disabledMessage`). Gates only *add info*; decision-change requests skip it.
- `feedback_add_info` — structured context, no decision change ("Won't change future decisions").
- `request_approve` — declined order is legitimate ("Trains future decisions").
- `request_decline` — order is fraud ("Reinforces the decline network-wide").

### 3.3 Capability groups (for access control, §8.3)

| Group | Cost | Capabilities |
|---|---|---|
| **Decisions** (6 tokens/call) | Real-time, billed per decision | Approve/Decline · Approve refund · Approve dispute · Coupon eligibility · Add-to-cart risk gate · Fast-track trusted customer · Policy eligibility · Address change review |
| **Signals** (2 tokens/call) | Read-only risk attributes | Consumer trust score · Risk score · IP quality · Email reputation · Account age & history · Trusted payment methods · Bot signal · Cross-merchant behavior |
| **LLM tools** (220 tokens/call) | Agentic analysis, higher latency | Review customer · Analyze transaction · Summarize case · Deep investigation |

### 3.4 The CapsPanel

A popover (from the sidebar "6 capabilities live" button) listing the six core capabilities with descriptions and ENABLED status: *"Every surface in ForterCIP runs on the same agentic data layer you can wire into your own tools via MCP."*

---

## 4. Information architecture

```
Intro hero  ──►  App shell
                 ├── Chat            (default tab; thread + right rail)
                 ├── Pulse           (command center; hosts Investigate full view)
                 ├── Pinned          (mobile-only tab: pin board)
                 ├── Agents          (console: live agents, templates, builders)
                 ├── Platform
                 │    ├── Apps        (MCP clients & business apps setup)
                 │    ├── Connectors  (business systems, OAuth, tool toggles)
                 │    └── Access      (capability grants per touchpoint/system)
                 └── Overlays: ⌘K ask-bar · CapsPanel · FeedbackFlow ·
                               AuthModal · toasts · TweaksPanel (demo controls)
```

Global interactions available everywhere: **⌘K / Ctrl-K** opens the ask-bar; **Esc** closes any overlay; a custom `open-order` event routes an order id to the chat rail dossier (desktop ≥1100px) or the full Investigate view (mobile).

---

## 5. ASCII wireframes

All frames: dark navy `#070B12` ground, Poppins, Forter blue `#005DE8` (bright accent `#2A8BFF`), flat — no gradients. Semantic colors: green `#00D894` (approve/trust), red `#FF6161` (decline/risk), amber `#FFB547` (review/warn).

### 5.1 Intro hero

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ◉ Forter CIP                                  Customer intelligence · Demo │
│                                                                            │
│  ● THE CUSTOMER INTELLIGENCE PLATFORM          ┌─[float]──────────────┐    │
│                                                │ ✓ Trusted identity   │    │
│  Know who                                      │   Approved in 312ms  │    │
│  to trust.          (blue)                     └──────────────────────┘    │
│                                                ┌─[panel]──────────────┐    │
│  ForterCIP turns Forter's network              │ ⌾ Trust Index   LIVE │    │
│  intelligence into a live command              │      ╭────────╮      │    │
│  center — every order, identity and            │     ( 96.4    )      │    │
│  signal at your fingertips, one                │      ╰─gauge──╯      │    │
│  question away, with the power to              │ ──────────────────── │    │
│  act on any answer.                            │ ● 40E031C  $96   APP │    │
│                                                │ ● 40E031D  $212  APP │    │
│  [ Enter the command center → ]                │ ● 40E031F  $1.4K DEC │    │
│  No setup · ask anything                       └──────────────────────┘    │
│                                                ┌─[float]──────────────┐    │
│  <500ms          6              97.8%          │ ⚠ Network reputation │    │
│  Decision   Live capabilities  7-day approval  │   Fraud ring blocked │    │
└────────────────────────────────────────────────┴──────────────────────┴────┘
```

### 5.2 App shell + Pulse (command center)

```
┌──────────────┬─────────────────────────────────────────────────────────────┐
│ ◉ ForterCIP  │  ┌─KPI──────┐ ┌─KPI──────┐ ┌─KPI──────┐ ┌─KPI──────┐        │
│ [+ New chat] │  │✓ 94.2%   │ │▲ +6.8%   │ │◇ 71%     │ │↻ 0.21%   │        │
│              │  │ +1.8pts  │ │ +0.9pts  │ │ +4pts    │ │ −0.05pts │        │
│  ▸ Chat      │  │ Approval │ │ Auth up- │ │ Dispute  │ │ False-   │        │
│  ▸ Pulse   ● │  │ rate     │ │ lift     │ │ win rate │ │ decline  │        │
│              │  └──────────┘ └──────────┘ └──────────┘ └──────────┘        │
│ PLATFORM     │  ┌─FlowMap─────────────────────────────────────────────┐    │
│  ▸ Agents ·6 │  │ Connected systems     Forter platform               │    │
│  ▸ Apps      │  │ ┌─────────┐  ┌─ Touchpoints ────────────────────┐   │    │
│  ▸ Connectors│  │ │Salesforce⇄│ │Signup*·Login 840K·Cart*·Checkout │   │    │
│  ▸ Access    │  │ │Zendesk  ⇄│  │1.4M·Coupon*·Payment·Refund·Disp.│   │    │
│              │  │ │Segment  →│  └───────────↓ events in───────────┘   │    │
│ RECENTS      │  │ │Snowflake←│  ┌─ CUSTOMER TRUST INTELLIGENCE ───┐   │    │
│  Why was 40E…│  │ │Claude   →│  │ 3.6M Decisions ▲4% ~ sparkline  │   │    │
│  Fraud ring… │  │ │Slack    →│  │ 34.5M Signals ▲2% · 890K LLM ▼1%│   │    │
│              │  │ │Bedrock  →│  └───────────↓ runs triggered──────┘   │    │
│ ┌──────────┐ │  │ │OMS ⌐custom│ ┌─ Agents & jobs ─────────────────┐   │    │
│ │Viewing as│ │  │ └─────────┘  │[Fraud agent 18K][Policies 1.9K]  │   │    │
│ │⌕ Risk    │ │  │  (hover any  │[Support 6.2K][Loyalty 1.2K]      │   │    │
│ │  Analyst ▾│ │  │   node to    │[High-risk 4.8K][Auth report 30] │   │    │
│ └──────────┘ │  │   trace path)└──────────────────────────────────┘   │    │
│ « Collapse   │  └─────────────────────────────────────────────────────┘    │
│ ● 6 caps live│  ┌─Dept──────┐┌─Dept──────┐┌─Dept──────┐  (6 flip cards)    │
│ (LG) Liron G.│  │◇ Fraud Ops││□ Payments ││? Support  │ back: stat, asks,  │
│              │  │ 3,240 q/mo││ 1,520 q/mo││ 4,860 q/mo│ tools, sent/recv   │
│              │  └───────────┘└───────────┘└───────────┘                    │
│              │  [⌕][My board·3][Fraud watch·2][+ New view]   [+ Add widget]│
│              │  ┌─Lead widget──────┐┌─Pinned card─────┐┌─Pinned card────┐  │
│              │  │Top active agents │ │● Ask Orders    ││● Network intel │  │
│              │  │/Top used signals │ │Approval 7d     ││Fraud ring      │  │
│              │  │ ranked list, imp.│ │[area chart]    ││[stacked bars]  │  │
│              │  └──────────────────┘└─────────────────┘└────────────────┘  │
│              │  Chargeback recovery · Ask Disputes · live                  │
│              │  [47 open][71% win vs 52% ind.][$128K recovered]            │
│              │  [reasons HBar]  [recent disputes list w/ status]           │
└──────────────┴─────────────────────────────────────────────────────────────┘
```

### 5.3 ⌘K ask-bar (command overlay)

```
        ┌─────────────────────────────────────────────────────────┐
        │ ?  Ask about any order, identity, signal or metric…  [↑]│
        ├─────────────────────────────────────────────────────────┤
        │ TRY ASKING                       (role-aware, analyst:) │
        │ [▲ What impact did the fraud agent have this week?]     │
        │ [◇ How many borderline orders did the agent flip?]      │
        │ [⌕ Why was order 40E018J declined?]                     │
        │ [▨ Show me the top declined reasons this week]          │
        │ [⚡ Has a new fraud ring hit my network?]                │
        └─────────────────────────────────────────────────────────┘
   thinking:  ● ● ●  Querying the agentic data layer…
   answered:
        ┌─────────────────────────────────────────────────────────┐
        │ ● Ask Orders · answered in 0.4s                         │
        │ Daily approval rate — last 7 days                       │
        │  96.4% Today   97.8% 7-day avg   −1.4pt vs avg          │
        │  [smoothed area chart, 7 points, last point labeled]    │
        │  Approval has held between 97%–98.7% …                  │
        │ ⌕ Risk Analyst lens: The Jul 7 dip tracks the           │
        │   fraud-ring pressure — check ring traffic first.       │
        │ [ Pin to view ▾ ]  [ Ask another ]                      │
        └─────────────────────────────────────────────────────────┘
```

Routing: order ids → open dossier (toast: "Investigate Order — opened dossier for {id}"); known intents → one of 12 answer cards; anything else → live LLM answer attributed to "Ask Orders · live answer". Unreachable backend → graceful text fallback.

### 5.4 Chat + right rail (pin board mode)

```
┌──────────────┬───────────────────────────────────┬────────────────────────┐
│ (sidebar     │  (◉) Hi 👋 — I'm ForterCIP, your   │ ● My board · live      │
│  as in 5.2)  │      customer intelligence agent.  │ 3 pinned insights      │
│              │      Ask about any order… pin it…  │ Your working set —     │
│              │                                    │ search·filter·keep     │
│              │  [suggestion chips when thread new]│ [⌕][My board·3][+]     │
│              │                                    │ [All][Ask Orders][Net] │
│              │           you: Why was order       │ ┌─pin───────────────┐  │
│              │                40E018J declined? ⏺ │ │● Investigate Order│  │
│              │                                    │ │40E018J — L.Rivas  │  │
│              │  (◉) ● Investigate Order · 40E018J │ │DECLINED·High conf │  │
│              │  ┌──────────────────────────────┐  │ │[open full dossier]│  │
│              │  │ ✕ DECLINED · High confidence │  │ └───────────────────┘  │
│              │  │ $1,800 · Visa                │  │ ┌─pin───────────────┐  │
│              │  │ Customer  Luis F. C. Rivas   │  │ │● Ask Orders       │  │
│              │  │ Top signal Network reputation│  │ │Approval trend 7d  │  │
│              │  │ Linked    2 orders dev·email │  │ │[mini area chart]  │  │
│              │  │ Decisioned Jul 7 19:22 <500ms│  │ └───────────────────┘  │
│              │  │ Forter declined 40E018J with │  │                        │
│              │  │ high confidence… (explain)   │  │ (empty state: "Ask a   │
│              │  │ [Open full dossier][Pin ▾]   │  │  question, then hit    │
│              │  └──────────────────────────────┘  │  Pin to view…")        │
│              │  ────────────────────────────────  │                        │
│              │  [ Ask about any order… ]      [↑] │                        │
│              │  autocomplete: ask + action sugs;  │                        │
│              │  ↑↓ browse · Tab complete · Enter  │                        │
└──────────────┴───────────────────────────────────┴────────────────────────┘
```

### 5.5 Chat right rail (dossier mode)

```
┌────────────────────────────┐
│ [←][Explain][Feedback][Pin▾][Request decline / Change to approve]          │
│ ● Investigate Order · live │
│ 40E018J                    │
│ Luis F. Caicedo R. · $1,800│  ┌ chip: ✕ DECLINED  High confidence
│                            │  └ Jul 7, 19:22 · <500ms
│ ● Identity                 │
│  Name / Email / Account /  │
│  Device / Locale / Geo /   │
│  IP (warn) / Network /     │
│  Payment  + cart item      │
│ ● Signal constellation · 8 │
│ [Constellation|Factors|Linked]  ← segmented control
│        ✦ risk              │
│    ✦       ✦ ok            │   nodes orbit the identity core;
│  ✦   (◉)     ✦ info        │   stronger signals orbit closer;
│    ✦       ✦               │   hover reads the signal note
│        ✦                   │
│  ■Risk ■Trust ■Context     │
└────────────────────────────┘
```

### 5.6 Investigate (full dossier, inside Pulse)

```
┌─[views tabs][⌕ 40E018J ✕][⌕ 40E025T]──────────────────────────────────────┐
│ [●40E018J][●40E025T]  Investigate Order · one identity, every signal      │
│                                                        [ Pin to view ▾ ]  │
│ ┌─Identity col──────┐ ┌─Signal constellation────┐ ┌─Right col───────────┐ │
│ │ ┌───────────────┐ │ │ 8 signals evaluated     │ │ Decision factors ·8 │ │
│ │ │ ✕ DECLINED    │ │ │      ✦ Network rep      │ │ ⚠ Network reputation│ │
│ │ │ High conf ·   │ │ │   ✦        ✦            │ │   IP associated w/  │ │
│ │ │ Jul 7, 19:22  │ │ │      (◉)       ✦        │ │   prior fraud…      │ │
│ │ └───────────────┘ │ │   ✦        ✦            │ │ ⚠ Manipulated conn. │ │
│ │ Name  Luis F. C.  │ │      ✦   ✦              │ │ ⚠ Order velocity    │ │
│ │ Email luislicona… │ │                         │ │ ⚠ High-value luxury │ │
│ │ Age   152 days    │ │ hover a signal —        │ │ ✦ Account age 152d  │ │
│ │ Device iPhone·Web │ │ stronger orbit closer   │ │ ✓ Email history     │ │
│ │ Locale es-419     │ │ ■Risk ■Trust ■Context   │ │ Cart: Tag Heuer     │ │
│ │ Geo   Colombia    │ │                         │ │  F1 watch $1,750 ×1 │ │
│ │ IP    38.224.…⚠   │ │                         │ │ Linked orders       │ │
│ │ Pay   Visa $1,800 │ │                         │ │  40E017P DECLINED   │ │
│ └───────────────────┘ └─────────────────────────┘ │  40E016K DECLINED   │ │
│                                                   │ Act on this order   │ │
│                                                   │ [Explain decision]  │ │
│                                                   │ [Add supporting info│ │
│                                                   │ [Change to approve] │ │
│                                                   │ Actions call the    │ │
│                                                   │ same MCP tools…     │ │
│                                                   └─────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
```

### 5.7 Feedback wizard (modal)

```
┌─────────────────────────────────────────────────────┐
│ ▤ Structured Tool · request_approve             [✕] │
│ Request approval  40E018J                           │
│ Tell Forter this declined order is legitimate…      │
│ ● Trains future decisions                (blue)     │
├─────────────────────────────────────────────────────┤
│ [Add supporting info | Request approval]  (segment) │
│ EVIDENCE  Add at least one section or a reason      │
│ ▸ ⚇ Customer's online presence              (2) ▾   │
│    [✓] Verified social media profile                │
│    [✓] Email in use over 12 months                  │
│    [ ] Prior legitimate purchases on file           │
│ ▸ ▢ Good order characteristics                      │
│ ▸ ⚑ Disagree with the decline                       │
│ ▸ ▤ Contacted the issuing bank                      │
│ ▸ ◇ Policy abuse doesn't apply                      │
│ REASON (optional free text)                         │
│ [ Customer verified via phone…            ]         │
├─────────────────────────────────────────────────────┤
│ Step 1 of 2 · Evidence     [Cancel]  [Continue →]   │
└─────────────────────────────────────────────────────┘
Step 2 = Review: syntax-highlighted JSON Request payload → [Submit]
Done   = ✓ + JSON Response {success:true}
Gate   = spinner "Checking eligibility · can_submit_feedback" →
Blocked= "Feedback window closed" + msg + offer decision-change path
Decline intent replaces evidence with confidence radio:
  (•) Not sure — something feels off        not_sure
  ( ) High confidence — strong evidence     high_confidence
  ( ) Victim confirmed — cardholder report  victim_confirmed
```

### 5.8 Agents console

```
┌─ Agents · 6 live   Purpose-built agents on Forter's data layer            │
│                       [list|cards] [✦ Create with AI] [⚙ Build manually]  │
│ ┌─rail───────────┐ ┌─detail─────────────────────────────────────────────┐ │
│ │ [⌕ search]     │ │ ◇ Fraud agent                     [Active ▣] [Run] │ │
│ │ ACTIVE       6 │ │ Reviews every borderline order and pulls           │ │
│ │ ● Fraud agent  │ │ additional identity/device/network data to         │ │
│ │ ● Policies ag. │ │ override the decision…                             │ │
│ │ ● Support prof.│ │ [On every borderline decision][Investigate Order · │ │
│ │ ● Loyalty mon. │ │  Explain Order · Request Approve/Decline][→Forter] │ │
│ │ ● High-risk al.│ │ ┌─ROI──────────────────────────────────────────┐   │ │
│ │ ● Auth sentinel│ │ │ $486K Decisions improved   +$61K this month  │   │ │
│ │ TEMPLATES   11 │ │ │ 2,340× return · cost $208 → net $485,792     │   │ │
│ │ ▤ Dispute dig.+│ │ └──────────────────────────────────────────────┘   │ │
│ │ ▨ Decline-spike│ │ 18K runs · 94% success · 3.1s avg · 0 attention    │ │
│ │ ▢ Limited-item │ │ RUN TRACE (run #18,204)                            │ │
│ │ ◦ False decline│ │  ◉ trigger  On every borderline decision           │ │
│ │ ⚑ Confirmed-fr.│ │  ▤ tool     Pull the full dossier (Investigate O.) │ │
│ │ … 6 more       │ │  ▤ tool     Fetch additional evidence (9 signals)  │ │
│ └────────────────┘ │  ◇ logic    Re-score with enriched data            │ │
│                    │  ⚡ action   Request Approve / hardened decline     │ │
│                    └────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
AI composer: describe goal → agent designs trace → review → deploy.
Manual builder: step-by-step flow editor (trigger → tools → logic → action).
Templates: 1-click deploy (+) or open detail first.
```

### 5.9 Access control — "By item" and "By capability" (matrix)

```
┌─ Access control      Configure which capabilities each touchpoint and     │
│                      system can call        [By item | By capability]     │
│ ┌─rail──────────────┐ ┌─detail──────────────────────────────────────────┐ │
│ │ [Touchpoints|Sys.]│ │ ▢ Checkout      11 of 20 capabilities enabled   │ │
│ │ ▢ Checkout  11 en.│ │                              [⌕ find capability]│ │
│ │ ⚇ Login      9 en.│ │ ● DECISIONS · 6 tokens/call · billed per dec.   │ │
│ │ + Signup     7 en.│ │   Approve / Decline          6 tok        [ON]  │ │
│ │ ▢ Payment    8 en.│ │   Coupon eligibility         6 tok        [ON]  │ │
│ │ ▢ Refund     8 en.│ │   Fast-track trusted cust.   6 tok        [ON]  │ │
│ │ ◇ Dispute    8 en.│ │   Approve refund             6 tok        [off] │ │
│ │ ▢ Add to cart 6   │ │ ● SIGNALS · 2 tokens/call · read-only           │ │
│ │ ⚑ Add coupon  5   │ │   Consumer trust score       2 tok        [ON]  │ │
│ └───────────────────┘ │   Risk score                 2 tok        [ON]  │ │
│  (hover any row →     │ ● LLM TOOLS · 220 tokens/call · deeper context  │ │
│   tooltip w/ example) │   Analyze transaction        220 tok      [ON]  │ │
│                       └─────────────────────────────────────────────────┘ │
│ Matrix view: capabilities × all touchpoints (or systems); tap a dot to    │
│ grant/revoke; Coverage column shows n/8. Every flip fires a toast.        │
└───────────────────────────────────────────────────────────────────────────┘
```

### 5.10 Connectors

```
┌─ Connectors    Business systems Forter can read from and act on [list|▦] │
│ ┌─rail──────────┐ ┌─detail───────────────────────────────────────────┐   │
│ │ CONNECTED   3 │ │ [SF] Salesforce  ✓Connected        [Disconnect]  │   │
│ │ [SF]Salesforce│ │ Bring account, ARR, owner and open-case context  │   │
│ │ [SL]Slack     │ │ into answers — and write Forter risk back.       │   │
│ │ [SW]Snowflake │ │ READ-ONLY TOOLS                    3/3 allowed   │   │
│ │ NOT CONNECTED │ │  Read account & ARR                      [ON]    │   │
│ │ [ZD]Zendesk   │ │  Read open cases                         [ON]    │   │
│ │ [SH]Shopify   │ │  Read contact history                    [ON]    │   │
│ │ [SN]ServiceNow│ │ WRITE & DELETE TOOLS               3/3 allowed   │   │
│ │ [HS]HubSpot   │ │  Update record / Create task / Log activity      │   │
│ └───────────────┘ └──────────────────────────────────────────────────┘   │
│ Connect → AuthModal: [◉ Forter] ~~~ [SF]  "Authorize Salesforce —        │
│ Forter will be able to read data from and act on your behalf."           │
│ [Authorize] → connected, "permissions default to read-only" toast.       │
└───────────────────────────────────────────────────────────────────────────┘
```

### 5.11 Apps (bring ForterCIP into your tools)

```
┌─ Apps   Bring Forter into the assistants and tools your team already uses│
│ ┌─rail──────────┐ ┌─detail───────────────────────────────────────────┐   │
│ │ [⌕ search]    │ │ [CC] Claude Code   Available     [Copy endpoint] │   │
│ │ LLM (MCP)   6 │ │ CLI for developers                               │   │
│ │ ▸ Claude Code │ │ ① Verify claude --version                        │   │
│ │ ▸ Claude      │ │ ② claude mcp add forter --transport http         │   │
│ │ ▸ ChatGPT     │ │      https://portal.forter.com/mcp               │   │
│ │ ▸ Copilot     │ │ ③ /exit → ④ claude → ⑤ /mcp → ⑥ >forter          │   │
│ │ ▸ Gemini      │ │ ⑦ Authenticate with Forter SSO                   │   │
│ │ ▸ Other       │ │ ┌─terminal mock──────────────────────────────┐   │   │
│ │ BUSINESS APPS │ │ │ > /mcp                                     │   │   │
│ │ Salesforce…   │ │ │ Forter MCP Server ⚠ needs authentication   │   │   │
│ │ (7 apps)      │ │ │ ❯ 1. Authenticate   2. Disable             │   │   │
│ └───────────────┘ │ └────────────────────────────────────────────┘   │   │
│ Claude/ChatGPT guides embed step-by-step UI mocks of each client's       │
│ connector settings. Business apps: marketplace install + SSO + scopes.   │
└───────────────────────────────────────────────────────────────────────────┘
```

### 5.12 Mobile shell

```
┌──────────────────────────────┐   "More" bottom sheet:
│ ◉ ForterCIP        [?][+][LG]│   ┌──────────────────────────┐
│                              │   │ ▔▔ (grab)                │
│      (active tab content;    │   │ Viewing as: ⌕ Risk An. ▾ │
│       tapping an order in    │   │ PLATFORM                 │
│       chat opens the FULL    │   │ ▸ Apps — bring CIP into  │
│       Investigate view       │   │   your tools             │
│       instead of the rail)   │   │ ▸ Connectors — data srcs │
│                              │   │ ▸ Access — roles & perms │
│                              │   │ ACCOUNT                  │
│                              │   │ ● 6 capabilities live    │
├──────────────────────────────┤   │ (LG) Liron Goldenberg    │
│ [Chat][Pulse][Pinned⁴][Agents][More]                        │
└──────────────────────────────┘   └──────────────────────────┘
```

---

## 6. User stories

### Epic A — Ask anything (⌘K + answer cards)
- **A1.** As any user, I press ⌘K anywhere and ask a question in plain language, so I get an answer without leaving my context.
- **A2.** As any user, I see role-aware suggested questions when the ask-bar is empty, so I discover what the platform can answer.
- **A3.** As any user, asking a KPI/trend/aggregation question returns a **rich answer card** (chart + numbers + one-paragraph insight) attributed to the tool that answered it ("Ask Orders · answered in 0.4s").
- **A4.** As any user, asking about a specific order id jumps me straight into that order's dossier.
- **A5.** As any user, questions outside the 12 canned intents get a **live LLM answer** attributed "Ask Orders · live answer", and if the platform is unreachable I get an honest fallback message.
- **A6.** As any user, every answer shows a **role-lens takeaway** for my persona.
- **A7.** As any user, I can pin any answer to a saved view, or ask another question, without closing the overlay.

The 12 answer cards: approval trend (area), decline reasons (HBar), flagged yesterday (KPI trio), true cost of fraud (stacked cost bar, $1 → $2.55), first-time buyers (KPI trio), disputes snapshot (KPIs + HBar), ATO distribution (2 donuts), geo distribution (donut + dims), fraud ring (stacked bars by day/category), attack flow (Sankey), connection-type mix (grouped bars traffic vs fraud share), device-type mix (grouped bars).

### Epic B — Chat
- **B1.** As any user, I chat with ForterCIP in a persistent thread; new chats are listed in Recents with auto-titles from my first message.
- **B2.** As any user, the composer autocompletes over ask-suggestions *and* action-suggestions (↑↓ browse, Tab complete, Enter send).
- **B3.** As any user, chat answers reuse the same answer cards, order cards, and live answers as ⌘K, each with a lead-in line and pin actions.
- **B4.** As any user, asking about an order renders an **order card** (verdict chip, identity summary, explanation) with "Open full dossier".
- **B5.** As a desktop user, opening an order from chat shows the **rail dossier** beside the thread; on mobile it opens the full Investigate view.
- **B6.** As any user, phrasing an *action* in natural language ("pause the loyalty monitor", "connect Slack", "grant Investigate Order to Zendesk") starts a **guided action flow** in-thread (see Epic G/H/I workflows): the agent gathers missing parameters as chips, shows a confirm summary, executes with live progress lines, and ends with a done state + deep link to the relevant tab.
- **B7.** As any user, when no rail dossier is open, the right rail shows my **pin board** (searchable across all boards, tag-filtered by tool).

### Epic C — Pulse (command center) & saved views
- **C1.** As any user, Pulse opens with four headline KPIs (approval rate, auth uplift, dispute win rate, false-decline rate) with deltas.
- **C2.** As any user, the **FlowMap** shows my connected systems, touchpoints (with volumes or "+ Set up"), the trust-intelligence core (decisions/signals/LLM calls with sparklines), and agents/jobs — hovering any node traces its wiring end-to-end.
- **C3.** As any user, I see six **department cards**; flipping one reveals how that team uses ForterCIP (headline stat, example asks I can click to ask, tools they lean on, gadgets sent/received, live agents).
- **C4.** As any user, I curate **saved views** (boards) of pinned insights: create, rename (double-click or menu), delete (last board is protected), switch via tabs.
- **C5.** As any user, I add widgets via "+ Add widget" (opens ⌘K) or from starter suggestions when a board is empty; I remove them with ✕.
- **C6.** As any user, I can **search across all boards**; hits show which board a pin lives on and jump me there.
- **C7.** As any user, pinned order dossiers appear as investigate-tabs beside my view tabs.
- **C8.** As any user, the bottom of Pulse always shows the **chargeback recovery** panel (open disputes, win rate vs industry, recovered QTD, reasons, recent disputes with won/lost/review status).
- **C9.** As any user, a **live decision stream** feeds the platform (intro panel + stream-driven surfaces) with order id, buyer type, geo, amount, verdict, and top signal.

### Epic D — Investigate (identity dossier)
- **D1.** As a risk user, I open one order and see the **verdict** (decision, confidence, timestamp), full **identity panel** (name, email, account age, device, locale, geo, IP with reputation warning, payment), and **cart**.
- **D2.** As a risk user, I read the **signal constellation**: every evaluated signal orbits the identity; stronger signals orbit closer; color = risk/trust/context; hovering reads the underlying note. A **factors list** and **linked orders** (by device/email/IP, with their verdicts) give the same data in list form.
- **D3.** As a risk user, I can switch between the sample dossiers (decline 40E018J / approve 40E025T patterns) and keep multiple dossier tabs open beside my views.
- **D4.** As a risk user, I can **Explain this decision** (one-shot human-readable reasoning inline).
- **D5.** As a risk user, I can act: **Add supporting info**, **Change to approve** (on declines), **Request decline** (on approves), or open a dispute — all via the guided feedback flow; a note reminds me these call the same MCP tools exposed to my own agents.
- **D6.** As a risk user, I can pin the dossier to any board.

### Epic E — Feedback loop
- **E1.** As a merchant user, adding info first runs the `can_submit_feedback` **eligibility gate**; if the window is closed I see why, plus the decision-change path that isn't gated.
- **E2.** As a merchant user, I build structured **evidence** across five sections (online presence, good order characteristics, disagree with decline, contacted issuing bank, policy abuse n/a), each with toggleable fields that compile into the tool payload, plus optional free-text reason. At least one field or a reason is required.
- **E3.** As a merchant user, requesting a **decline** asks only my confidence level (`not_sure` / `high_confidence` / `victim_confirmed`).
- **E4.** As a merchant user, step 2 shows the exact **JSON request** the tool will receive; after submit I see the JSON response and a success toast. Impact is labeled honestly per intent (won't change / trains / reinforces network-wide).
- **E5.** As a merchant user, each dossier shows **feedback impact** context: identity-cluster status, network status, what happens to future orders, and my lever.

### Epic F — Agents
- **F1.** As an ops user, I see all **live agents** with status, description, trigger/tools/delivery chips, run stats (runs, success rate, avg duration, needs-attention), and an **ROI block** (headline value, this-month delta, return multiple, cost → net).
- **F2.** As an ops user, I read a **run trace** for any agent: trigger → tool steps (with sample data rows) → logic → action.
- **F3.** As an ops user, I deploy from **11 templates** (dispute digest, decline-spike watch, limited-item guardian, false-decline rescue, confirmed-fraud feedback, integration health check, support queue triage, refund auto-approval, chargeback cohort watch, real-time ATO response, custom sentinel) — one click or after reviewing the template's trace.
- **F4.** As an ops user, I create agents with the **AI composer** (describe the goal; the system designs the flow) or the **manual flow builder** (trigger → tools → logic → action), optionally seeded from a chat-created draft ("Refine in flow builder").
- **F5.** As an ops user, I **pause/resume**, **test-run** (executes the trace once against live data, no schedule change), and **remove** agents (confirm; history archived) — from the console or from chat.
- **F6.** As any user, I ask for an agent's **impact** in chat ("what impact did the fraud agent have this week?") and get a compiled report: headline ROI, weekly value trend or outcome rows depending on my question, cost → net.

### Epic G — Platform: Apps (MCP distribution)
- **G1.** As a developer/analyst, I follow **step-by-step setup guides** (with embedded UI mocks / terminal mock) to add the Forter MCP server to Claude Code, Claude, ChatGPT (with its developer-mode caveat), GitHub Copilot, Gemini, or any MCP client.
- **G2.** As any user, I copy the MCP endpoint in one click; auth is always **Forter SSO / OAuth**; tools are scoped by my role and governed under Access.
- **G3.** As a business user, business-app installs (Salesforce, Zendesk, Shopify, ServiceNow, Slack, HubSpot, Snowflake) follow marketplace install + SSO + scope selection.

### Epic H — Platform: Connectors
- **H1.** As an admin, I connect a business system via an **authorization modal** (Forter ⇄ system) that states exactly what Forter will be able to do; connections default to read-only scopes.
- **H2.** As an admin, I toggle individual **read-only** vs **write & delete** tools per connector; every permission is scoped and revocable.
- **H3.** As an admin, I disconnect a system; dependent flows pause safely (and resume on re-enable).

### Epic I — Platform: Access control
- **I1.** As an admin, I manage which **capabilities** (Decisions / Signals / LLM tools, with per-call token costs) each **touchpoint** (checkout, login, signup, payment, refund, dispute, cart, coupon) and each **system** (Stripe, Salesforce, Zendesk, Segment, Snowflake, custom OMS, AWS Bedrock) may call — via a per-item view or a full **matrix** with coverage counts.
- **I2.** As an admin, every grant/revoke applies to new calls immediately and fires a confirmation toast; bulk grant/revoke by capability group is supported (including from chat).
- **I3.** As an admin, I can ask in chat "what can Zendesk access today?" and get a compiled access review (enabled vs disabled capabilities).
- **I4.** As any user, hovering a touchpoint/system explains it with a concrete example ("A reseller bot grabbing limited SKUs is stopped pre-checkout").

### Epic J — Roles & personalization
- **J1.** As any user, I switch persona ("Viewing as") from the sidebar or chat; suggestions, takeaways, and starter content adapt; the choice persists.
- **J2.** As any user, my boards, active view, and persona survive reloads (per-user persistence).

### Epic K — Disputes
- **K1.** As a finance/risk user, I get the dispute posture anywhere (⌘K card, chat, Pulse panel, dedicated view): open disputes, win rate vs industry, recovered QTD, reason mix, recent disputes with status.

---

## 7. Key workflows

### 7.1 Ask → answer → pin
```
⌘K (or chat) → type/pick question → route:
  order id     → open dossier (rail on desktop, full view on mobile)
  known intent → answer card + role lens → [Pin to view ▾ → board | __new]
  otherwise    → live LLM answer (attributed, pinnable)
Pinned answers render live on Pulse boards and in the chat rail.
```

### 7.2 Investigate → act
```
Open dossier (from ask, chat, stream, FlowMap, or pinned tab)
  → read verdict / identity / constellation / factors / linked orders
  → Explain decision (inline)
  → Act: Add info | Change to approve | Request decline | Dispute
       └→ Feedback wizard (7.4)
```

### 7.3 Chat guided action (generic shape)
```
User phrases an action → intent router matches type
  → GATHER   missing params as chip questions (pre-filled from the text)
  → CONFIRM  human-readable summary of exactly what will happen
             (+ alternates: e.g. "Prefer to build it yourself?")
  → AUTH     (connector-connect only) authorization modal
  → EXECUTE  live progress lines or animated run trace
  → DONE     toast + result card (e.g. impact report) + deep link tab
Supported: agent create/pause/resume/remove/test-run/impact,
template deploy, app setup guide, connector connect/on/off,
access grant/revoke/review/bulk, role switch, view create.
```

### 7.4 Feedback submission
```
Entry (dossier/rail/chat) with intent add_info | approve | decline
  add_info → can_submit_feedback gate → blocked? show reason + ungated
             decision-change alternative
  approve/add_info → Evidence step (5 structured sections + reason)
  decline          → Confidence step (3 levels)
  → Review step: exact JSON request → submit → JSON response + toast
```

### 7.5 Agent lifecycle
```
Create: chat guided | AI composer | manual builder | template (1-click)
  → agent = trigger + tool steps + logic + action, deployed live
Operate: pause/resume (trigger disarmed/armed), test-run (once, live data),
  impact report (ROI + trend/outcomes), remove (drain, archive, confirm)
Observe: run stats, run traces, needs-attention count, Pulse leaderboard
```

### 7.6 Connect & govern
```
Connector: pick system → AuthModal (least-privilege OAuth) → test event →
  connected (read-only default) → toggle read/write tools → disconnect pauses flows
Access: pick touchpoint/system (or matrix) → flip capability toggles →
  applies immediately → toast; reviews & bulk ops available from chat
Apps: pick client → follow embedded guide → SSO auth → tools scoped by role
```

---

## 8. Architecture (fork mapping)

| ForterOS concept | cloudflare-os primitive |
|---|---|
| ForterCIP shell (all §5 surfaces) | `workshop-frontend` replacement/re-skin (React, same build chain) |
| Workspace / user session | Durable Object per workspace (upstream unchanged) |
| Forter capabilities (Ask Orders, Investigate Order, …) | New **`gatekeeper-forter`** wrapping the Forter Portal MCP, with per-capability enable flags, action logging, and human-in-the-loop on side-effecting tools (`request_approve/decline`, `feedback_add_info`) |
| Connectors (Slack, Snowflake, Salesforce, Zendesk, …) | Gatekeepers (existing: slack, google, github, confluence; new: snowflake, jira, salesforce/zendesk as needed) with the design's read/write tool toggles mapped to gatekeeper capability grants |
| Access control UI (§5.9) | UI over gatekeeper capability grants (touchpoints/systems = principals) |
| Agents & jobs (§5.8) | OS agents + `gatekeeper-scheduler` for cron/interval triggers; run traces = agent action logs |
| Pinned views/boards | Typed storage per user (upstream `typed-storage`) |
| Live decision stream | Server-sent events from the Forter gatekeeper (demo: seeded pool) |
| Answer cards / charts | Frontend chart primitives (pure SVG: area, HBar, donut, stacked bars, grouped bars, Sankey, gauge, constellation) |
| LLM answers | OS agent loop (pi-agent-core), provider-configurable |
| Auth | Forter SSO (OIDC) replacing the OAuth sign-in flow in `docs/oauth-signin.md` |
| Hosting | Self-hosted `workerd` (deployment tooling to be built as part of the plan) |

**Demo vs live:** the mockup ships with a coherent demo dataset (approval series, 859 declines/10 reasons, orders 40E018J/40E025T, disputes, agents with ROI). The implementation keeps this as a **demo mode** (seeded fixtures behind the same interfaces) so every surface works before the live Forter MCP is wired in; live mode swaps the data source per capability.

**Error handling:** every ask surface has an explicit unreachable-platform fallback message; feedback gate failures show the server's `disabledMessage`; connector auth is cancelable mid-flight; destructive actions (agent remove, view delete) confirm and protect invariants (last view undeletable).

**Testing:** unit tests for the intent routers (ask routing + chat action routing — pure functions with well-defined fixtures), payload compilation in the feedback wizard, pin hydration/persistence; integration tests per gatekeeper (upstream `integration-tests` pattern); visual QA against the design project snapshots.

---

## 9. Design language

- **Ground:** near-black navy `#070B12`; cards on `rgba(255,255,255,.05)` lines.
- **Type:** Poppins (Light→Black); numeric emphasis extra-bold; mono for ids/emails/IPs.
- **Brand:** Forter blue `#005DE8`, bright `#2A8BFF`, deep-blue fills at 16% alpha.
- **Semantics:** approve/trust `#00D894` · decline/risk `#FF6161` · review/warn `#FFB547` · context `#2A8BFF`.
- **Flat:** no gradients (DS rule); rounded 8–12px radii; subtle dashed guides for chart grids.
- **Motion:** count-up numerals, 900ms ease-out gauges, staggered stream entries, FlowMap wire tracing; respects `prefers-reduced-motion`.

---

## 10. Phasing (suggested MVP cut)

1. **P0 — Shell + Ask + Investigate (demo mode):** intro, sidebar shell, ⌘K with 12 answer cards + live fallback, chat with cards/order cards, full + rail dossier, pins/views, Pulse KPIs + boards, roles/lenses. All on demo fixtures.
2. **P1 — Feedback + live data:** `gatekeeper-forter` wired to Portal MCP (6 capabilities + feedback tools), feedback wizard end-to-end, disputes live, live decision stream.
3. **P2 — Agents:** console, templates, test-run, pause/resume/remove, chat guided agent actions, impact reports; scheduler-backed execution.
4. **P3 — Platform governance:** Connectors (OAuth + tool toggles), Access control (item + matrix), Apps setup guides, chat-driven governance actions.
5. **P4 — Hardening:** workerd self-host deployment, SSO, multi-user persistence, FlowMap live wiring, mobile polish.

Out of scope for v1: real Salesforce/Zendesk/etc. bidirectional sync beyond the toggle model; ChatGPT connector beyond documented limited support; the 3D bag/concierge experiments in the design project (separate prototypes).
