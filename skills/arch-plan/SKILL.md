---
name: arch-plan
description: Write a restructuring plan that leads with a one-page Target Architecture Blueprint (workflow spine, dataclass contracts, flat 3-layer module map, anti-bloat check) and phased verifiable steps for two-round browser review (clean_arch_review). Use after arch-diagnose or before any refactor.
---

# Restructuring plan and two-round review gate

Read-only for source code. Write only `.clean-arch/plan.md` (diagrams inline as Mermaid) and,
for structural refactoring, `.clean-arch/rules.toml`.

## Two-round planning model

Base every plan on `.clean-arch/diagnosis.md` (trace steps to `A-id` architecture findings and
`H-id` hygiene items). Write in the language rule of `clean-arch`, keeping the file readable in
~5 minutes (under ~180 lines and ~12,000 characters, diagrams ≤ 15 nodes).

Unless the diagnosis found zero structural `A-id` issues (or the whole scope fits in ≤ 5 trivial
steps), plan in **two rounds**:

- **Round 1 (`Plan — Round 1: Target Blueprint & Hygiene Sweep`)**:
  - Put the full **Target Architecture Blueprint** at the top so the user reviews and approves
    the final module layout, workflow spine and `@dataclass` contracts *before* any file changes.
  - Keep **Round 1 Steps** (≤ 8 steps) strictly subtractive: delete parallel versions (`*_v2`,
    copied directories), merge duplicate helpers, remove dead modules/functions, fix broken
    imports and remove internal compatibility shims.
  - End with a short **Round 2 Preview** listing the `A-id` structural changes that will follow
    once the tree is clean.
- **Round 2 (`Plan — Round 2: Spine, Data Contracts & Module Boundaries`)**:
  - Written *after* Round 1 steps are executed and verified on the de-noised tree (re-run
    `clean_arch_facts` summary first so diagrams and line counts reflect reality).
  - Keep the approved **Target Architecture Blueprint** (adjusted only if Round 1 uncovered new
    facts) and write **Round 2 Steps** (≤ 8 steps per subsystem, bottom-up across subsystems):
    1. **Data contracts first**: introduce `@dataclass` models (`models.py` / `types.py`) and
       replace cross-module raw `dict` bags / 6+ loose parameter lists (`A-id` contract findings).
    2. **Infrastructure & I/O edge**: consolidate scattered `open()`, HTTP/LLM/DB calls and
       `os.environ` reads into single-home infra/config modules so domain modules become pure.
    3. **Module boundaries & cycles**: merge fragmented concept files into cohesive domain
       modules, dissolve `utils.py` / `helpers.py` grab-bags, break cycles and invert upward
       domain -> serving/CLI imports.
    4. **Explicit workflow spine & de-bloating**: extract thin orchestrator functions (30–50
       lines reading like a table of contents) from tangled scripts, and inline single-impl
       `ABC`s / pass-through wrappers.
  - Write `.clean-arch/rules.toml` (template: `../arch-map/references/templates/ai/rules.toml`)
    encoding the 3 layers, `no_cycles = true`, and `[[forbid]]` rules (including forbidding
    domain modules from importing network/web/CLI frameworks directly). `clean_arch_facts check`
    fails before Round 2 execution and must pass at the end.

## Plan structure (`.clean-arch/plan.md`)

````markdown
# Plan (Round <1|2>): <short title>

## Goal
<2-3 sentences: what becomes clear after this refactor, in plain words>

## Scope & external contracts kept
- **In**: <packages / directories> | **Out**: <untouched areas>
- **External contracts kept**: <CLI flags, HTTP routes, checkpoint/file formats, published API; everything internal may change with callers updated in the same step>

## Target architecture blueprint
### 1. Workflow spine (storyline)
- `<entry_or_pipeline.py>::<run_fn>`: `1. <step> -> 2. <step> -> 3. <step> -> 4. <step>`

### 2. Core `@dataclass` contracts
| Model (`path`) | Key fields | Replaces |
|---|---|---|
| `OrderSummary` (`shop/core/models.py`) | `total, count, average` | raw 3-key dicts across `stats.py` & `notify.py` |

### 3. Flat 3-layer module map
| Layer | Module | Single responsibility | Consolidates / replaces |
|---|---|---|---|
| Entry & Spine | `shop/jobs.py` | CLI & batch workflow orchestration | — |
| Domain | `shop/core/pricing.py` | Pure price & tax calculation | removes upward `notify` call |
| Infra & IO | `shop/infra/mail.py` | Outbound receipt delivery | `channels.py` single-impl ABC |

### 4. Before / after package dependencies
```mermaid
flowchart TD
  %% current dependencies (verified with clean_arch_facts verify)
```
```mermaid
flowchart TD
  %% target dependencies (flat top-down layers)
```

### 5. Anti-bloat self-check
- [ ] Zero new `ABC` / `Protocol` / `Factory` / `Registry` with fewer than 2 concrete implementations
- [ ] Zero pass-through wrapper modules or `utils.py` / `helpers.py` grab-bags
- [ ] Spine functions stay ~30–50 lines and delegate mechanics to deep modules

## Decisions
| ID | Decision | Traces to | Alternative rejected (and why) |
|---|---|---|---|

## Steps (Round <1|2>)
### S1 <verb + object, tracing to H-id or A-id>
- Change: <exact move, merge, `@dataclass` introduction, spine extraction or deletion>
- Callers: <every import, string ref, config, script, test and route updated in this step>
- Delete: <files / symbols / shims removed in this step>
- Verify: `<exact test/smoke command>` (+ `clean_arch_facts`: no new unresolved imports or cycles)
- Risk: <low/medium/high + why>

## Deletion list (this round)
<Every file, module, class, alias or function that will not exist after this round.>

## Round 2 preview / Not doing
<In Round 1: list the A-ids scheduled for Round 2 right after cleanup. In Round 2: list out-of-scope temptations deliberately skipped.>

## Open questions
| Q | Question | Default assumed | Steps affected |
|---|---|---|---|
````

Rules for steps and diagrams:
- At most 8 steps per round. Every step leaves tests green and could be its own commit.
- Name exact verification commands (`pytest tests/test_billing.py`, not "run tests").
- Generate the Before diagram from `clean_arch_facts` (`mermaid --view packages`, add `--focus`
  for subsystems), follow `../arch-map/references/views.md` (ASCII subgraph ids, no `<-->`, no
  `-.text.->`, `classDef` instead of `linkStyle`), and run `clean_arch_facts` `verify` on
  `.clean-arch/plan.md` before opening review (note: `verify` checks the code as it exists now,
  so label or dash hypothetical target-only edges in the After diagram if needed, or verify the
  Before diagram cleanly and inspect any After-diagram notices).

## Review loop

1. Submit `.clean-arch/plan.md` via `clean_arch_review` with a clear `title` (include `Round 1` or `Round 2`, and pass `root` when calling over MCP):
   - **MCP App hosts (Antigravity side pane)**: call `clean_arch_review` with `action: "panel"` (default), then stop editing and wait for the reviewer's submitted decision message.
   - **HTTP browser hosts (opencode / CLI / non-UI MCP)**: call `clean_arch_review` with `action: "open"`, show the returned URL to the user in your reply, then immediately call `clean_arch_review` again with the same `path` and `action: "wait"`.
2. Handle the decision:
   - `approved`: archive to `.clean-arch/plans/<YYYY-MM-DD>-r<1|2>-<slug>.md` and execute the
     round's steps.
   - `approved_with_notes`: fold non-scope-breaking notes into `.clean-arch/plan.md`, archive as
     above, and execute.
   - `changes_requested`: address every annotation (*delete*, *replace*, *comment*). Keep edits
     focused on what the reviewer touched so the round-over-round diff stays crisp, then re-open
     review.
   - `timeout` or tool unavailable: ask the user in chat to review `.clean-arch/plan.md` and
     reply "approved" or give feedback.
3. Never modify source files before approval. When Round 1 finishes execution, proceed directly
   into drafting and reviewing Round 2 whenever structural `A-id` findings remain.
