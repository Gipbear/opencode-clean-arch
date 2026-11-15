---
name: clean-finish
description: Completion gate for refactors and agent-written changes - verifies no parallel versions, compatibility shims, broken imports, commented-out code, debug output, version-named identifiers or narrative comments remain, the deletion list is done and tests pass. Use before declaring any refactor or feature done, or when the user asks to check for leftovers.
---

# Clean finish gate

A change is done only when this gate passes. Run it on the diff since the base commit
recorded in `.clean-arch/baseline.md`, or since the merge base with the main branch when there
is no baseline.

## Checks

Run all of them. Fix what fails, then re-run the whole gate.

1. **Leftover scan.** `clean_arch_leftovers` with `since: <base>`, or
   `python3 ../clean-arch/scripts/leftover_scan.py --since <base> --fail-on high`.
   - `high` findings (parallel-version, duplicate, broken-import, compat-shim): must be zero.
     An exception is allowed only for a compat shim protecting an external contract named in
     the approved plan. Cite the plan line in the report.
   - `medium` (commented-code, debug, version-name): fix every one, or justify each in the
     report (for example, `print` in a CLI is output, not debug).
   - `low` (narrative-comment, unreferenced): review every one. Delete unreferenced code
     unless it is an entry point, a plugin hook or used by string lookup.
2. **Deletion list.** For every item in the plan's deletion list, confirm the file or symbol is
   gone, `clean_arch_facts` `importers` on the old module path is empty, and `rg -n "<old name>"`
   finds no references outside changelogs and `.clean-arch/`.
3. **Structure.** `clean_arch_facts`:
   - no unresolved internal imports;
   - no cycle that did not exist in the baseline;
   - if `.clean-arch/rules.toml` exists, `check` passes, or every violation is pre-existing
     and listed.
4. **Behaviour.** Run the full test command from the baseline. Nothing that passed before may
   fail now. Run the plan's smoke checks.
5. **Diff hygiene.** Read `git diff --stat <base>` and skim the full diff:
   - no stray files (`*.bak`, `*.orig`, scratch scripts, notebooks with outputs, `.env`);
   - no unrelated reformatting;
   - no new dependencies the plan did not mention;
   - generated docs and diagrams are up to date with the code.
6. **Comments.** Apply `comment-hygiene` to the changed files.

## Report

Write `.clean-arch/finish-report.md` and show the table to the user:

```markdown
| Check | Result | Notes |
|---|---|---|
| Leftovers high / medium / low | 0 / 0 / 3 reviewed | … |
| Deletion list | 12/12 removed | |
| Unresolved imports / new cycles | 0 / 0 | |
| Rules check | pass | |
| Tests | 214 passed (baseline 214) | |
| Diff hygiene | clean | |
```

If something cannot reach zero, say so plainly with the reason. Never mark the gate as passed
while a `high` finding remains without a plan-backed exception.
