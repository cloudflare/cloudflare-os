# Evidence inventory

- `deterministic/`: final synthetic reference/fault run using the external host-state oracle and BAML optional-field normalization.
- `pilot/`: corrected two-tier paid pilot. Stopped on provider HTTP 503, with an unsettled reservation. Only completed rows are summarized; a planned run is not a completed trial.
- `pilot-superseded/`: **excluded from comparative conclusions**. Initial BAML signature ambiguity, unequal callback exposure and incomplete tool-use oracle invalidated it. It remains here for cost/provenance transparency. Interruption left one uncertain request.
- `deterministic-superseded/`, `deterministic-v2/`, `deterministic-before-null-normalization/`: development measurements, excluded from final summary. Retained to avoid hiding failed adapter assumptions.
- `dry-run/`: initial zero-cost prompt inventory, before review corrections; the final prompts are retained verbatim in corrected pilot/calls.jsonl. Not a frozen final campaign protocol.
- `performance.json`: local compiler and workerd microbenchmarks; 5 fresh processes and 30 same-process validations, plus 1 startup and 5 repeated requests per runtime. Repeated requests recompile BAML; not precompiled SDK performance.
- `summary.json`, `summary.csv`, `deterministic.csv`, `charts.svg`: derived by summarize.ts; no manual measurement edits.

All data and prompts are synthetic. Dollar figures are usage × published text-token prices, not settled invoices. Provider response IDs are identifiers, not credentials. Exact executed candidate source is retained with each attempt. `sourceHash` fingerprints task source at run start; formatting and subsequent oracle corrections are described in the report. Compiler/bridge versions are pinned in the committed lockfile.
