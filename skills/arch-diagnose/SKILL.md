---
name: arch-diagnose
description: Read-only architecture diagnosis of a Python (and small frontend) codebase - finds parallel versions, duplication, cycles, wrong dependencies, god classes, shallow layers and leftover code, ranked by impact with file:line evidence. Use before any restructuring, or when the user asks what is wrong with a codebase's structure.
---

# Architecture diagnosis

Read-only. Write only `.clean-arch/diagnosis.md` (and scratch files under `.clean-arch/cache/`).

The facts scripts live in the `clean-arch` skill (`../clean-arch/scripts/` relative to this
file). Prefer the `clean_arch_facts` and `clean_arch_leftovers` tools when they are available.

## Procedure

1. **Collect facts.** Run these:
   - `clean_arch_facts` summary (add `include` for a subsystem);
   - `clean_arch_leftovers`;
   - change frequency of files that still exist, because churn multiplies the cost of every
     smell:
     ```bash
     git log --since=6.months --name-only --format= -- '*.py' | sort | uniq -c | sort -rn |
       while read n f; do [ -f "$f" ] && echo "$n $f"; done | head -30
     ```
2. **Understand intent before judging.** Read the project instruction files (`AGENTS.md`,
   `CLAUDE.md`) first, then the README, entry points (CLI scripts, `__main__`, servers,
   notebooks) and the main config files. Write down in one sentence what the system does and
   what its main flows are. A structure is only wrong relative to what the code needs to do.
3. **Inspect the top candidates.** Open the code behind the biggest facts: duplicate groups,
   cycles, god classes, long functions, broken imports, and modules with many importers.
   Check each against the catalogue in `references/smells.md`. For duplicates, diff the
   copies (`diff -u a.py b.py`). The differences decide which copy survives and what must
   be ported. Before proposing to delete or move anything, run `clean_arch_facts` with
   `command: importers` on it. That lists the imports (tests included) and mentions in
   scripts, configs, docs and Dockerfiles.
4. **Apply the tests that prevent churn.**
   - *Deletion test.* Delete the module or layer in your head. If its complexity vanishes,
     it was a pass-through and should go. If the complexity reappears in N callers, it is
     earning its keep.
   - *One adapter means a hypothetical seam.* An interface, ABC, registry or factory with a
     single implementation is indirection, not architecture. Two real implementations make
     a seam.
   - *Coupling balance.* Strong coupling is fine at short distance (same module or package)
     and costly across packages. It matters most when one side changes often.
   - *Not every oddity is a problem.* Research scripts, one-off experiments and generated
     code can stay as they are if nothing imports them. List them under "Keep as is".
5. **Rank.** Score impact (reading or change cost), spread (files or callers) and churn
   (change frequency) from 1 to 3 each, and multiply. Record the scores in the evidence file.
   Keep the top 10–15. Merge symptoms that share one cause (for example, a hundred duplicate
   functions caused by one copied package is one finding).
6. **Write `.clean-arch/diagnosis.md`** using the format below, in the language rule of the
   `clean-arch` skill. Then give the user a 5–10 line summary in chat, not the whole file.

## Output format

```markdown
# Architecture diagnosis: <scope>

<2-3 sentences: what the system does, main flows, overall state>

## Numbers
| Metric | Value |
|---|---|
| Python files / lines | … |
| Duplicate groups / identical files | … |
| Package cycles / module cycles | … |
| Broken internal imports | … |
| Leftovers high / medium | … |

## Findings
| ID | Level | Problem | Evidence | Direction | Risk |
|---|---|---|---|---|---|
| F1 | system | `<old_pkg>/` duplicates `<pkg>/` | N identical files, M duplicate bodies (leftovers) | delete after diffing; port deliberate differences | <who imports it: tests, scripts, docs> |
| … |

Level is one of: system / package / module / class / function.

## Keep as is
- `<path>`: <why it looks odd but is fine>

## External contracts (proposed)
- <published API, CLI flags, file formats, checkpoints, HTTP endpoints, DB schema that outside users rely on>

## Open questions
- <things only the user can answer, e.g. "is legacy_agent still deployed anywhere?">
```

Keep the file under ~6,000 characters. In the findings table, keep Problem under ~25 words and
Evidence to at most two references. Put long evidence lists (all duplicate pairs, scores and
so on) into `.clean-arch/cache/diagnosis-evidence.md` and link to it.
