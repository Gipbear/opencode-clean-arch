# Module index (for agents)

Generated from code at <commit>. Keep in sync when modules move. Humans: see `docs/architecture/`.

## Layers (top to bottom)

1. `<entry layer: scripts/, cli>` – entry points only; no logic beyond argument parsing and wiring
2. `<application layer>` – …
3. `<domain/core layer>` – …
4. `<infrastructure layer>` – …

## Packages

### `<pkg.sub>` – <responsibility in one line>
- Key symbols: `<Class>` (<path>:<line>), `<function>` …
- Depends on: `<pkg.a>`, `<pkg.b>`
- Used by: `<pkg.c>`
- Put here: <kinds of new code that belong here>
- Not here: <kinds of code that look related but belong elsewhere, and where>

## Entry points

| Command | Module | Purpose |
|---|---|---|
| `python -m <pkg.mod> …` | `<path>` | … |

## External contracts

<Interfaces outside users depend on; changes need explicit user approval.>

## Known violations

<Full output of `clean_arch_facts` `check` that is not fixed yet, grouped by kind. `development.md`
shows only layer/forbidden/cycle items and budget counts.>
