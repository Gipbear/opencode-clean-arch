---
name: clean-finish
description: Completion gate for architectural refactors and agent-written changes - verifies zero leftovers, deletion list completion, flat 3-layer rules check, target spine/dataclass blueprint alignment, zero new bloat, and passing tests. Use at the end of clean-arch or on /clean-finish.
---

# Clean finish gate

A refactor or feature is done only when **both** code hygiene and architectural integrity pass.
Run this gate against the base commit recorded in `.clean-arch/baseline.md` (or the merge base
with the main branch when running standalone).

*Note on two-round `clean-arch` runs:* After Round 1 (hygiene sweep), run checks 1, 2 and 4 as a
fast checkpoint before planning Round 2. After Round 2 (or a single-round run), run **all** seven
checks below.

## Checks

Run every check, fix what fails, and re-run until clean.

1. **Leftover scan.** Run `clean_arch_leftovers` with `since: <base>` (or
   `python3 ../clean-arch/scripts/leftover_scan.py --since <base> --fail-on high`):
   - `high` (`parallel-version`, `duplicate`, `broken-import`, `compat-shim`): **must be zero**.
     The only valid exception is a shim protecting an external contract explicitly listed in the
     approved plan (cite the plan line).
   - `medium` (`commented-code`, `debug`, `version-name`): fix all, or justify genuine CLI
     output.
   - `low` (`narrative-comment`, `unreferenced`): clean up narrative comments; delete newly
     unreferenced symbols unless they are entry points, framework hooks or string-loaded targets.

2. **Deletion list audit.** For every file, module, class or alias in the plan's deletion list
   (across both Round 1 and Round 2):
   - confirm the file/symbol is gone;
   - `clean_arch_facts` `importers` on removed module paths is empty;
   - `rg -n "<old_name>"` finds zero hits outside changelogs and `.clean-arch/`.

3. **Layer & dependency rules (`clean_arch_facts`).**
   - Zero unresolved internal imports;
   - Zero package or module import cycles that were not explicitly exempted;
   - Run `clean_arch_facts` `check` against `.clean-arch/rules.toml`: all layer rules,
     `no_cycles`, and `[[forbid]]` rules (including forbidden framework/network imports inside
     domain/core modules) pass, with no unlayered core/service modules hiding outside `layers`
     unless listed in `exempt`.

4. **Blueprint & anti-bloat audit.** Compare the resulting code against the approved Target
   Architecture Blueprint in `.clean-arch/plan.md` and `clean_arch_facts` `summary`:
   - **Spine**: each planned workflow entry point / orchestrator reads as a concise step-by-step
     storyline (~30–50 lines) rather than a 200-line tangled function;
   - **Data contracts**: planned `@dataclass` models exist and cross-module raw `dict` bags named
     in the plan are gone;
   - **Zero new bloat**: `Speculative abstractions & one-method classes` and `Grab-bag modules`
     in `clean_arch_facts` show **no** newly introduced single-implementation `ABC` / `Protocol`
     / `Factory`, pass-through wrapper module, or new `utils.py` / `helpers.py` file.

5. **Behaviour.** Run the full test command and smoke checks from `.clean-arch/baseline.md`.
   Nothing that passed in the baseline may regress.

6. **Diff hygiene.** Inspect `git diff --stat <base>` and skim the diff:
   - no stray scratch files (`*.bak`, `*.orig`, temp scripts, `.env`, unstripped notebook outputs);
   - no unrelated formatting churn;
   - no unapproved third-party dependencies.

7. **Comment hygiene.** Apply `comment-hygiene` to all modified and newly created files (accurate
   1–3 line module responsibility docstrings; zero edit-narration comments).

## Report

Write `.clean-arch/finish-report.md` and present the concise summary table:

```markdown
| Check | Result | Notes |
|---|---|---|
| Leftovers (high / medium / low) | 0 / 0 / 2 reviewed | … |
| Deletion list | 14/14 removed | 0 residual `rg` hits |
| Layer & forbidden-import rules (`check`) | pass | 3 layers, 0 cycles |
| Blueprint & anti-bloat audit | pass | spine + 4 `@dataclass` models in place; 0 single-impl ABCs |
| Tests & smoke checks | 214 passed (baseline 214) | |
| Diff & comment hygiene | clean | |
```

Never mark the gate passed while an unapproved `high` leftover, broken import, or new layer/cycle
violation remains.
