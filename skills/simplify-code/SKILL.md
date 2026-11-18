---
name: simplify-code
description: Behaviour-preserving simplification of Python functions and classes (and small JS/CSS pages) for immediate readability - single abstraction level in workflow spines, guard clauses, dataclass parameters over raw dicts, and zero speculative abstraction. Use during refactors or when simplifying code.
---

# Simplifying functions and classes

The aim is code a teammate understands on first read without jumping through five wrappers or
reverse-engineering untyped dicts. Clarity beats cleverness: a direct three-line `if` beats a
nested comprehension.

## Safety first

- Before simplifying untested logic, add a characterization test pinning public inputs to outputs
  (including key edge/error cases). Keep these tests permanently.
- Tackle one kind of simplification per pass and run tests after each pass.
- Preserve observable behaviour at external boundaries: return values, public exceptions, side
  effects, parsed log formats and CLI outputs.
- Validate untrusted data once at system boundaries (CLI, HTTP, disk, LLM outputs); delete
  redundant defensive `isinstance` / `.get()` clutter inside trusted internal code.

## Spine vs. capability functions (keep abstraction levels clean)

- **Workflow spine / orchestrator functions** (30–50 lines): every line should sit at the same
  high level (`cfg = load_config(...)`, `items = fetch_items(...)`, `ranked = score_items(...)`).
  Extract inline regexes, file path math, retry loops and formatting details into named helpers or
  domain modules so the main storyline jumps off the page.
- **Domain capability functions**: do one job deeply behind a small, typed signature. Prefer
  taking and returning explicit `@dataclass` models rather than mutating passed-in `dict` bags in
  place.

## Function level

| Instead of | Write |
|---|---|
| nested `if` / `try` pyramids | guard clauses with early `return` / `continue` |
| mixing I/O, parsing and domain math in one body | load/parse at the edge, pass typed data to a pure calculation helper |
| 6+ parameters threaded unchanged across layers | one `@dataclass(frozen=True)` built once at the entry boundary |
| `flag=True` / `mode="v2"` switching two behaviours | two focused functions; delete whichever branch has no real caller |
| `dict[str, Any]` with string keys passed across functions | a `@dataclass` (`TypedDict` only at raw JSON boundaries) |
| `try: … except Exception: pass` | catch the specific expected exception, or let bugs raise |
| `if x is not None and x != "" and len(x) > 0` | `if x:` when types permit |
| `for i in range(len(xs))` | `for x in xs`, `enumerate`, `zip` |
| nested ternaries or 2+ clause comprehensions | a plain loop or a well-named helper |
| repeated magic numbers / string keys | named module constants or `Enum` |
| sync and async copies of the same body | one implementation (plus a thin adapter only if both are used) |

Size guide (guideline, not a rigid quota): functions ≲ 40–50 lines, nesting ≤ 3, parameters ≤ 5.
Split only when the extracted piece represents a clear concept; never chop a cohesive algorithm
into tiny 5-line fragments that force the reader to scroll up and down.

## Class level (zero bloat)

- **Class with `__init__` + one method and no stateful lifecycle** → plain function.
- **`ABC`, `Protocol`, `Factory` or `Registry` with <= 1 concrete implementation** → delete the
  indirection and use the concrete class/function directly.
- **Copy-pasted subclasses** → one class parameterised by data or a callable.
- **Attributes set outside `__init__` or "only valid in mode X"** → split into distinct stage
  types (`RawInput` -> `ValidatedJob`) or two focused classes.
- **Trivial getters/setters or pass-through methods** → plain attributes/properties or direct
  calls.
- **Hand-written `__init__`/`__repr__`/`__eq__` on value containers** → `@dataclass`.

## Naming & dead code

- Name symbols after **domain meaning**, never implementation history (`InvoiceSummary`, not
  `NewBillingDictV2`; `score_candidates`, not `process_data_step2`).
- Verbs for functions, nouns for data models and collaborators, predicates for booleans
  (`is_valid`, `has_discount`). Keep one term per concept across the codebase (match
  `.clean-arch/glossary.md` when present).
- Delete unused functions, arguments, branches, imports, config keys and commented-out code after
  confirming zero references with `rg` and `clean_arch_leftovers`.

## Small frontend pages

- Plain ES modules (`api.js`, `state.js`, `render.js`); no new framework or bundler.
- Centralise `fetch` calls and error handling in one place; prefer `textContent` over `innerHTML`.
- One clean stylesheet with CSS variables; remove unused selectors, `console.log` and `debugger`.

## What not to do

- Do not reformat untouched lines or fight the repository's formatter.
- Do not break external contracts listed in the plan.
- Do not introduce design patterns, base classes or `utils.py` files "for future extensibility".
