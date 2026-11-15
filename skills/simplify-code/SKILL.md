---
name: simplify-code
description: Behaviour-preserving simplification of Python functions and classes (and small JS/CSS pages) for readability - guard clauses, fewer parameters, dataclasses over dicts, removing speculative abstraction, defensive noise and dead branches. Use when cleaning up code you touch during a refactor, or when the user asks to simplify or make code readable.
---

# Simplifying functions and classes

The aim is code a new teammate understands on first read. Clarity beats brevity: a
three-line `if` is better than a clever one-liner.

## Safety first

- Before simplifying code without tests, add a characterization test that pins the current
  behaviour of the public function (inputs to outputs, including error cases). Keep these
  tests; they are not scaffolding.
- Work on one smell per pass over a file, and run the tests after each pass.
- Keep observable behaviour: return values, raised exception types at public boundaries, side
  effects, log lines other tools parse, and CLI output formats.
- Keep validation at system boundaries (user input, files, network, model outputs). Remove
  only redundant checks inside trusted code.

## Function level

| Instead of | Write |
|---|---|
| nested `if` pyramids | guard clauses with early `return` / `continue` |
| a function mixing levels (IO + parsing + math) | a short top-level function that reads as steps, calling well-named helpers |
| 6+ parameters threaded through layers | one `@dataclass(frozen=True)` config built at the entry point |
| `flag=True` switching between two behaviours | two functions; delete the branch nobody uses |
| `dict[str, Any]` with string keys passed around | a `@dataclass` (TypedDict only at JSON boundaries) |
| `try: … except Exception: pass` | catch the specific exception you can handle, or let it raise |
| `if x is not None and x != "" and len(x) > 0` | `if x:` when the types allow it |
| index loops `for i in range(len(xs))` | `for x in xs`, `enumerate`, `zip` |
| nested ternaries or comprehensions with 2+ `for`/`if` | a plain loop or a named helper |
| magic numbers and strings repeated | a named module constant |
| manual resource handling | `with` blocks |
| sync and async copies of one function | one implementation; if both are needed, keep one thin adapter |

Size guide (not a hard rule): functions ≲ 40 lines, nesting ≤ 3, parameters ≤ 5. Split
only where a name makes the code clearer. Do not chop a clear function into fragments.

## Class level

- A class with `__init__` plus one public method and no reused state should be a function.
- An ABC, registry or factory with one implementation should be the concrete class.
- Copy-pasted subclasses should be one class with a parameter.
- Attributes set outside `__init__`, or optional attributes that are "only set in mode X",
  mean the class is two classes, or needs explicit state.
- Getters and setters that only forward should become plain attributes or properties.
- Use `@dataclass` for value objects instead of hand-written `__init__`/`__repr__`/`__eq__`.

## Names

- Name things after what they mean in the domain, not how they are implemented or which
  attempt they were: `retriever`, not `new_retriever2`.
- Verbs for functions, nouns for values. Booleans read as predicates (`is_ready`,
  `has_answer`).
- One concept, one name across the codebase. Use the glossary in `.clean-arch/glossary.md`
  if it exists.

## Dead code

- Delete unused functions, parameters, branches, imports and config keys. Confirm with `rg`
  (and `clean_arch_leftovers` "unreferenced") that nothing uses them, including strings and
  scripts.
- Delete commented-out code. Git keeps it.

## Small frontend pages

- Plain ES modules; no new framework or build step for a small page.
- One `api.js`-style module for `fetch` calls with a single error path.
- Build DOM from small render functions. Prefer `textContent` over `innerHTML` for user and
  model data (also prevents XSS).
- Keep one stylesheet. Remove unused selectors and duplicated rules. Use CSS variables for
  repeated colours and sizes.
- No `console.log` or `debugger` left behind.

## What not to do

- Do not reformat whole files or change quote style; leave that to the project's formatter.
- Do not rename public API or external contracts as part of a simplification.
- Do not add layers, patterns or generic utilities "for the future".
