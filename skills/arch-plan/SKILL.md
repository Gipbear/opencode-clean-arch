---
name: arch-plan
description: Write a restructuring plan with before/after architecture diagrams, an explicit deletion list and verifiable steps, then get it approved through the browser review page (clean_arch_review). Use after arch-diagnose, or whenever a refactor needs user sign-off before code changes.
---

# Restructuring plan and review gate

Read-only for source code. Write only `.clean-arch/plan.md` (diagrams inline as Mermaid) and
the proposed `.clean-arch/rules.toml`.

## Writing the plan

Base the plan on `.clean-arch/diagnosis.md`. Every step must trace to a finding (F-ids). Write
it in the language rule of the `clean-arch` skill, and keep it to what a reviewer can read in
about 5 minutes: under ~150 lines and ~10,000 characters, with diagrams of ≤ 15 nodes.

Use this structure:

````markdown
# Plan: <short title>

## Goal
<2-3 sentences: the target state in plain words>

## Scope
- In: <packages / directories>
- Out: <explicitly untouched areas>

## External contracts kept
<Only these stay compatible; everything else may change and callers are updated in the same step.>
- <e.g. CLI `python -m pkg.run --config …` flags; checkpoint files under `ckpt/`; HTTP `/api/ask`>

## Before / after
```mermaid
flowchart LR
  %% current package dependencies (from clean_arch_facts mermaid --view packages)
```
```mermaid
flowchart LR
  %% target package dependencies
```
<Optional: target core class diagram, ≤ 12 classes.>

## Decisions
| ID | Decision | Because (finding) | Alternative rejected |
|---|---|---|---|

## Steps
### S1 <verb + object, e.g. "Delete legacy_agent copy">
- Change: <what moves, merges, splits or gets deleted>
- Callers: <how every reference is updated: imports, strings, configs, scripts, docs>
- Delete: <files / symbols removed in this step>
- Verify: `<exact command>` (+ `clean_arch_facts`: no unresolved imports)
- Risk: <low/medium/high + why>

## Deletion list
<Every file, package, class or function that will no longer exist at the end. This list is what
clean-finish checks against.>

## Not doing
<Tempting changes left out on purpose, and findings deferred to a later plan (say which).>

## Open questions
| Q | Question | Default this plan assumes | Steps affected |
|---|---|---|---|
````

Rules for good steps:
- At most 8 steps per plan. Each step leaves the code working and could be a separate commit.
- Order the steps: delete dead code and copies first (cheap, shrinks the rest), then break
  cycles and fix dependency direction, then merge and split modules, then simplify classes
  and functions.
- Each step names its verification command. "Run tests" is not enough. Give the command and
  say which tests cover the change.
- No step may introduce a compatibility shim unless it touches a listed external contract.
- A step that depends on an open question names it (`Q1`) and the default it assumes; the
  reviewer answers in the review.
- Generate the before diagram from `clean_arch_facts` (`mermaid --view packages`, add `--focus`
  for subsystems), then trim it. Draw the after diagram by editing the before diagram, so the
  difference is visible. Mark nodes with classes, never with `linkStyle <index>` (indexes shift
  when edges change):
  ```text
  classDef del stroke:#d33,stroke-dasharray:4
  classDef cycle stroke:#d33,stroke-width:2px
  class old_pkg del
  ```
- Follow the renderer notes in `../arch-map/references/views.md` (ASCII subgraph ids, no
  `<-->`, no `-.text.->`). Before submitting, run `clean_arch_facts` `verify` on
  `.clean-arch/plan.md` for the before diagram; the review result also lists rendering
  warnings to fix in the next revision.
- Write `.clean-arch/rules.toml` (template: `../arch-map/references/templates/ai/rules.toml`)
  so it encodes the after diagram: layers, and a `forbid` entry for every dependency the plan
  removes. `clean_arch_facts` `check` will fail now and must pass after the last step.

## Review loop

1. Call `clean_arch_review` with `path: ".clean-arch/plan.md"` and a short `title`. It starts
   the review page and returns its URL at once. Write the URL in your reply (the browser may
   not open on a remote or headless machine), then call `clean_arch_review` again with the same
   `path` and `action: "wait"`. That call returns when the user decides.
2. Read the result:
   - `approved`: copy the plan to `.clean-arch/plans/<YYYY-MM-DD>-<slug>.md` and continue.
   - `approved_with_notes`: apply the notes that do not change scope, mention them in the
     plan, archive it as above, and continue.
   - `changes_requested`: apply every annotation. A *delete* removes the quoted text, a
     *replace* swaps it, and a *comment* needs a change or a reply. Edit only what the
     feedback touches, so the reviewer's diff stays small. Then call the tool again.
   - `timeout` or the tool is unavailable: stop and ask the user in chat to review the file
     and reply "approved" or give feedback.
3. Never start executing on anything other than an approval.

Large changes: if the diagnosis needs more than 8 steps, write one plan per subsystem in
dependency order (lowest layer first) and review them one at a time.
