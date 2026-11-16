#!/usr/bin/env python3
"""Deterministic architecture facts for a Python (+ small frontend) repository.

Subcommands:
  summary   compact Markdown overview for humans and agents (default)
  json      full facts as JSON
  mermaid   draft diagrams: --view packages | classes
  check     verify .clean-arch/rules.toml (layers, forbidden imports, size budgets)
  importers who references a module/package: imports (tests too) and mentions in scripts, configs, docs
  verify    check Mermaid diagrams (.mmd, or ```mermaid blocks in .md) against the code: names that do
            not exist, dependency arrows with no matching import, wrong inheritance

Standard library only. The analysed code is parsed, never imported or executed.
"""

from __future__ import annotations

import argparse
import ast
import fnmatch
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pyindex import Module, RepoIndex, build_index  # noqa: E402

LONG_FUNCTION = 60
DEEP_NESTING = 4
MANY_PARAMS = 6
BIG_MODULE = 500
BIG_CLASS = 300
MIN_DUP_STATEMENTS = 6


def import_edges(index: RepoIndex, include_tests: bool) -> tuple[dict[tuple[str, str], int], list[dict]]:
    edges: Counter = Counter()
    unresolved: list[dict] = []
    for mod in index.modules.values():
        if mod.is_test and not include_tests:
            continue
        for ref in mod.imports:
            if ref.guarded == "TYPE_CHECKING":
                continue
            for target, name in index.resolve(mod, ref):
                if not target:
                    unresolved.append({"module": mod.name, "path": mod.path, "line": ref.line, "import": name})
                    continue
                if name is not None:
                    owner = index.modules[target]
                    if name not in owner.top_names and not owner.is_package_init:
                        unresolved.append({"module": mod.name, "path": mod.path, "line": ref.line,
                                           "import": f"{target}.{name}"})
                if target != mod.name:
                    if index.modules[target].is_test and not include_tests:
                        continue
                    edges[(mod.name, target)] += 1
    return dict(edges), unresolved


def collapse(name: str, depth: int, directories: frozenset[str] = frozenset()) -> str:
    """Collapse a dotted module name to `depth` parts; a plain module at that level folds into its directory."""
    parts = name.split(".")
    short = ".".join(parts[:depth])
    if directories and depth > 1 and len(parts) >= depth and short not in directories:
        return ".".join(parts[:depth - 1])
    return short


def directory_names(index: RepoIndex) -> frozenset[str]:
    names = set()
    for mod in index.modules.values():
        parts = mod.name.split(".")
        upto = len(parts) if mod.is_package_init else len(parts) - 1
        names.update(".".join(parts[:i]) for i in range(1, upto + 1))
    return frozenset(names)


def strongly_connected(nodes: set[str], edges: set[tuple[str, str]]) -> list[list[str]]:
    graph: dict[str, list[str]] = defaultdict(list)
    for a, b in edges:
        graph[a].append(b)
    index_of: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    result: list[list[str]] = []
    counter = [0]

    def visit(v: str) -> None:
        work = [(v, iter(graph[v]))]
        index_of[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on_stack.add(v)
        while work:
            node, it = work[-1]
            advanced = False
            for w in it:
                if w not in index_of:
                    index_of[w] = low[w] = counter[0]
                    counter[0] += 1
                    stack.append(w)
                    on_stack.add(w)
                    work.append((w, iter(graph[w])))
                    advanced = True
                    break
                if w in on_stack:
                    low[node] = min(low[node], index_of[w])
            if advanced:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[node])
            if low[node] == index_of[node]:
                comp = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    comp.append(w)
                    if w == node:
                        break
                if len(comp) > 1:
                    result.append(sorted(comp))

    for n in sorted(nodes):
        if n not in index_of:
            visit(n)
    return result


def dotted_text(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        head = dotted_text(node.value)
        return f"{head}.{node.attr}" if head else None
    return None


def class_usage(index: RepoIndex) -> dict[tuple[str, str], int]:
    """How many other modules reference each top-level class, via `from m import C` or `m.C`."""
    defined = {(m.name, c.name) for m in index.modules.values() for c in m.classes}
    users: dict[tuple[str, str], set[str]] = defaultdict(set)
    for mod in index.modules.values():
        module_aliases: dict[str, str] = {}
        for ref in mod.imports:
            resolved = index.resolve(mod, ref)
            if ref.is_from:
                for imported, (target, name) in zip(ref.names, resolved):
                    if not target or target == mod.name:
                        continue
                    if name and (target, name) in defined:
                        users[(target, name)].add(mod.name)
                    elif name is None:
                        alias = next((a for a, n in ref.alias_map.items() if n == imported), imported)
                        module_aliases[alias] = target
            else:
                for (alias, dotted), (target, _) in zip(ref.alias_map.items(), resolved):
                    if target and target != mod.name:
                        module_aliases[alias if alias != dotted.split(".")[0] else dotted] = target
        if mod.tree is None or not module_aliases:
            continue
        for node in ast.walk(mod.tree):
            if isinstance(node, ast.Attribute):
                owner = module_aliases.get(dotted_text(node.value) or "")
                if owner and (owner, node.attr) in defined:
                    users[(owner, node.attr)].add(mod.name)
    return {key: len(val) for key, val in users.items()}


DATA_DECORATORS = ("dataclass", "dataclasses.dataclass", "attr.s", "attrs.define", "define", "frozen")
DATA_BASES = ("NamedTuple", "TypedDict", "BaseModel", "Enum", "IntEnum", "StrEnum")


def type_names(annotation: str) -> set[str]:
    return set(re.findall(r"[A-Za-z_]\w*", annotation))


def class_facts(index: RepoIndex, include_tests: bool) -> list[dict]:
    """Classes ranked by architectural weight, so diagrams start from the classes that structure the code.

    Weight favours abstractions with subclasses, classes that hold other internal classes as
    collaborators, and classes with behaviour; plain records and exceptions rank low even when
    they are used everywhere.
    """
    usage = class_usage(index)
    mods = [m for m in index.modules.values() if include_tests or not m.is_test]
    names = {c.name for m in mods for c in m.classes}
    defined: dict[str, list[str]] = defaultdict(list)
    for m in mods:
        for c in m.classes:
            defined[c.name].append(m.name)
    subclasses: Counter = Counter()
    for m in mods:
        imported = {t for ref in m.imports for t, _ in index.resolve(m, ref) if t}
        for c in m.classes:
            for base in c.bases:
                short = base.split(".")[-1].split("[")[0]
                home = [d for d in defined.get(short, []) if (d == m.name and short != c.name) or d in imported]
                if home:
                    subclasses[(home[0], short)] += 1
    rows = []
    for mod in mods:
        for cls in mod.classes:
            typed = {**{k: v for k, v in cls.attributes.items() if v}, **cls.init_params}
            collaborators = sorted({n for t in typed.values() for n in type_names(t) if n in names and n != cls.name})
            public = [m.name for m in cls.methods if not m.name.startswith("_")]
            is_data = any(d in DATA_DECORATORS for d in cls.decorators) or \
                any(b.split(".")[-1] in DATA_BASES for b in cls.bases)
            is_error = any(b.split(".")[-1].endswith(("Error", "Exception", "Warning")) for b in cls.bases)
            used = usage.get((mod.name, cls.name), 0)
            subs = subclasses[(mod.name, cls.name)]
            weight = 3 * subs + 2 * len(collaborators) + min(len(public), 8) / 2 + min(used, 10) \
                + min(cls.length / 100, 4) + (2 if cls.abstract else 0)
            if is_data and not public:
                weight /= 2
            if is_error or cls.name.startswith("_"):
                weight = 0
            rows.append({"module": mod.name, "path": mod.path, "name": cls.name, "line": cls.line,
                         "lines": cls.length, "bases": cls.bases, "abstract": cls.abstract,
                         "methods": [m.name for m in cls.methods], "public_methods": public,
                         "attributes": cls.attributes, "init_params": cls.init_params,
                         "collaborators": collaborators, "subclasses": subs,
                         "used_by_modules": used, "weight": round(weight, 1)})
    return sorted(rows, key=lambda c: (-c["weight"], -c["lines"]))


def duplicates(index: RepoIndex) -> dict[str, list]:
    groups: dict[str, list[dict]] = defaultdict(list)
    loose: dict[str, list[dict]] = defaultdict(list)
    shapes: dict[str, list[dict]] = defaultdict(list)
    for mod in index.modules.values():
        funcs = list(mod.functions) + [m for c in mod.classes for m in c.methods]
        for fn in funcs:
            if fn.statements < MIN_DUP_STATEMENTS:
                continue
            entry = {"module": mod.name, "path": mod.path, "function": fn.qualname, "line": fn.line,
                     "lines": fn.length, "async": fn.is_async}
            groups[fn.body_hash].append(entry)
            loose[fn.loose_hash].append(entry)
            shapes[fn.shape_hash].append(entry)
    exact = [g for g in groups.values() if len(g) > 1]
    key = lambda g: tuple(sorted((e["path"], e["line"]) for e in g))  # noqa: E731
    exact_keys = {key(g) for g in exact}
    sync_async = [g for g in loose.values() if len(g) > 1 and len({e["async"] for e in g}) > 1
                  and key(g) not in exact_keys]
    known = exact_keys | {key(g) for g in sync_async}
    renamed = [g for g in shapes.values() if len(g) > 1 and key(g) not in known
               and not any(set(key(g)) <= set(k) for k in known)]
    file_groups: dict[str, list[str]] = defaultdict(list)
    sources = [(m.path, m.source, "#") for m in index.modules.values()]
    sources += [(f.path, (index.root / f.path).read_text(encoding="utf-8", errors="replace"), "//")
                for f in index.frontend]
    for path, source, comment in sources:
        normalized = "\n".join(ln.strip() for ln in source.splitlines()
                               if ln.strip() and not ln.strip().startswith(comment))
        if len(normalized) > 200:
            file_groups[Path(path).suffix + str(hash(normalized))].append(path)
    same_files = [sorted(v) for v in file_groups.values() if len(v) > 1]
    in_identical = {p for g in same_files for p in g}
    same_name = similar_same_name(index, in_identical)
    shared: Counter = Counter()
    for g in exact + renamed:
        paths = sorted({e["path"] for e in g} - in_identical)
        for i in range(len(paths)):
            for j in range(i + 1, len(paths)):
                shared[(paths[i], paths[j])] += 1
    sharing = [{"a": a, "b": b, "functions": n} for (a, b), n in shared.most_common() if n >= 3]
    return {"functions": sorted(exact, key=lambda g: -g[0]["lines"]),
            "renamed_functions": sorted(renamed, key=lambda g: -g[0]["lines"]),
            "sync_async": sorted(sync_async, key=lambda g: -g[0]["lines"]),
            "identical_files": same_files, "similar_files": same_name, "files_sharing_functions": sharing}


def similar_same_name(index: RepoIndex, skip: set[str]) -> list[dict]:
    import difflib
    by_base: dict[str, list[Module]] = defaultdict(list)
    for mod in index.modules.values():
        base = Path(mod.path).name
        if base != "__init__.py" and mod.code_lines >= 40 and mod.path not in skip:
            by_base[base].append(mod)
    pairs = []
    for mods in by_base.values():
        for i in range(len(mods)):
            for j in range(i + 1, len(mods)):
                a, b = mods[i], mods[j]
                ratio = difflib.SequenceMatcher(None, a.source.splitlines(), b.source.splitlines(),
                                                autojunk=False).ratio()
                if ratio >= 0.6:
                    pairs.append({"a": a.path, "b": b.path, "similarity": round(ratio, 2)})
    return sorted(pairs, key=lambda p: -p["similarity"])


def hotspots(index: RepoIndex) -> dict[str, list]:
    long_fn, deep, many, big_mod, big_cls = [], [], [], [], []
    for mod in index.modules.values():
        if mod.lines >= BIG_MODULE and not mod.is_test:
            big_mod.append({"path": mod.path, "lines": mod.lines})
        funcs = list(mod.functions) + [m for c in mod.classes for m in c.methods]
        for fn in funcs:
            where = {"path": mod.path, "function": fn.qualname, "line": fn.line}
            if mod.is_test:
                continue
            if fn.length >= LONG_FUNCTION:
                long_fn.append({**where, "lines": fn.length})
            if fn.nesting >= DEEP_NESTING:
                deep.append({**where, "depth": fn.nesting})
            if fn.params >= MANY_PARAMS:
                many.append({**where, "params": fn.params})
        for cls in mod.classes:
            if cls.length >= BIG_CLASS and not mod.is_test:
                big_cls.append({"path": mod.path, "class": cls.name, "line": cls.line, "lines": cls.length,
                                "methods": len(cls.methods)})
    return {
        "long_functions": sorted(long_fn, key=lambda x: -x["lines"]),
        "deep_nesting": sorted(deep, key=lambda x: -x["depth"]),
        "many_params": sorted(many, key=lambda x: -x["params"]),
        "big_modules": sorted(big_mod, key=lambda x: -x["lines"]),
        "big_classes": sorted(big_cls, key=lambda x: -x["lines"]),
    }


SCRIPT_SUFFIXES = (".sh", ".bash", ".yaml", ".yml", ".toml", ".cfg", ".ini")
SCRIPT_NAMES = ("Dockerfile", "Makefile", "Procfile", "Justfile")
PYTHON_RUN = re.compile(r"""python[0-9.]*['"]?(?:[\s,'"]+-[A-Za-z]+(?=[\s,'"]))*[\s,'"]+"""
                        r"""(?:-m[\s,'"]+([A-Za-z_][\w.]*)|([\w./-]+\.py)\b)""")


def process_calls(index: RepoIndex) -> list[dict]:
    """Calls into internal modules across a process boundary: subprocess `-m pkg.mod` and shell scripts."""
    def target_of(module: str | None, path: str | None) -> str | None:
        if module:
            return index._longest_module(module)
        mod = index.by_path.get((path or "").removeprefix("./"))
        return mod.name if mod else None

    calls: list[dict] = []
    for mod in index.modules.values():
        if mod.tree is None:
            continue
        for node in ast.walk(mod.tree):
            found: list[str | None] = []
            if isinstance(node, (ast.List, ast.Tuple)):
                items = [e.value if isinstance(e, ast.Constant) and isinstance(e.value, str) else None for e in node.elts]
                found = [target_of(items[i + 1], None) for i in range(len(items) - 1)
                         if items[i] == "-m" and items[i + 1]]
            elif isinstance(node, ast.Constant) and isinstance(node.value, str) and "python" in node.value:
                found = [target_of(m, p) for m, p in PYTHON_RUN.findall(node.value)]
            for target in found:
                if target and target != mod.name:
                    calls.append({"from": mod.name, "path": mod.path, "line": node.lineno, "to": target})
    for rel in index.other_files:
        p = Path(rel)
        if not (p.suffix in SCRIPT_SUFFIXES or p.name in SCRIPT_NAMES):
            continue
        try:
            text = (index.root / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for no, line in enumerate(text.splitlines(), 1):
            for m, path in PYTHON_RUN.findall(line):
                target = target_of(m, path)
                if target:
                    calls.append({"from": rel, "path": rel, "line": no, "to": target})
    return calls


def entry_points(index: RepoIndex) -> list[str]:
    return sorted(m.path for m in index.modules.values() if m.has_main_guard and not m.is_test)


def package_table(index: RepoIndex) -> list[dict]:
    stats: dict[str, dict] = defaultdict(lambda: {"files": 0, "lines": 0, "tests": 0})
    for mod in index.modules.values():
        top = mod.path.split("/")[0] if "/" in mod.path else "(root)"
        row = stats[top]
        row["files"] += 1
        row["lines"] += mod.lines
        row["tests"] += int(mod.is_test)
    fe: dict[str, int] = defaultdict(int)
    for f in index.frontend:
        top = f.path.split("/")[0] if "/" in f.path else "(root)"
        fe[top] += f.lines
    rows = []
    for top in sorted(set(stats) | set(fe)):
        rows.append({"dir": top, **stats.get(top, {"files": 0, "lines": 0, "tests": 0}), "frontend_lines": fe.get(top, 0)})
    return sorted(rows, key=lambda r: -(r["lines"] + r["frontend_lines"]))


def collect(index: RepoIndex, include_tests: bool, depth: int) -> dict:
    edges, unresolved = import_edges(index, include_tests)
    collapsed: Counter = Counter()
    dirs = directory_names(index)
    for (a, b), n in edges.items():
        ca, cb = collapse(a, depth, dirs), collapse(b, depth, dirs)
        if ca != cb:
            collapsed[(ca, cb)] += n
    module_nodes = {m.name for m in index.modules.values() if include_tests or not m.is_test}
    calls = process_calls(index)
    process_edges = sorted({(collapse(c["from"], depth, dirs), collapse(c["to"], depth, dirs))
                            for c in calls if c["from"] in index.modules})
    return {
        "root": str(index.root),
        "totals": {
            "python_files": len(index.modules),
            "python_lines": sum(m.lines for m in index.modules.values()),
            "test_files": sum(1 for m in index.modules.values() if m.is_test),
            "frontend_files": len(index.frontend),
            "frontend_lines": sum(f.lines for f in index.frontend),
            "classes": sum(len(m.classes) for m in index.modules.values()),
            "functions": sum(len(m.functions) + sum(len(c.methods) for c in m.classes) for m in index.modules.values()),
        },
        "packages": package_table(index),
        "entry_points": entry_points(index),
        "syntax_errors": [{"path": m.path, "error": m.syntax_error} for m in index.modules.values() if m.syntax_error],
        "module_cycles": strongly_connected(module_nodes, set(edges)),
        "package_cycles": strongly_connected({collapse(n, depth, dirs) for n in module_nodes}, set(collapsed)),
        "package_edges": [{"from": a, "to": b, "imports": n} for (a, b), n in sorted(collapsed.items())],
        "module_edges": [{"from": a, "to": b, "imports": n} for (a, b), n in sorted(edges.items())],
        "process_calls": calls,
        "process_edges": [{"from": a, "to": b} for a, b in process_edges if a != b],
        "unresolved_internal_imports": unresolved,
        "suspected_source_roots": index.suspected_source_roots(),
        "classes": class_facts(index, include_tests),
        "hotspots": hotspots(index),
        "duplicates": duplicates(index),
        "frontend": [asdict(f) for f in index.frontend],
    }


def fmt_brief(facts: dict) -> str:
    t, d, h = facts["totals"], facts["duplicates"], facts["hotspots"]
    rows = [
        ("Python files / lines", f"{t['python_files']} / {t['python_lines']} ({t['test_files']} test files)"),
        ("Frontend files / lines", f"{t['frontend_files']} / {t['frontend_lines']}"),
        ("Package cycles / module cycles", f"{len(facts['package_cycles'])} / {len(facts['module_cycles'])}"),
        ("Unresolved internal imports", str(len(facts["unresolved_internal_imports"]))),
        *([("Imports that may point at a missing source root",
            ", ".join(f"`{r['import_root']}` ({r['imports']})" for r in facts["suspected_source_roots"][:5]))]
          if facts["suspected_source_roots"] else []),
        ("Identical files (groups)", str(len(d["identical_files"]))),
        ("Copied / renamed-copy function groups", f"{len(d['functions'])} / {len(d['renamed_functions'])}"),
        (f"Modules >= {BIG_MODULE} lines / classes >= {BIG_CLASS} lines",
         f"{len(h['big_modules'])} / {len(h['big_classes'])}"),
        (f"Functions >= {LONG_FUNCTION} lines / >= {MANY_PARAMS} params",
         f"{len(h['long_functions'])} / {len(h['many_params'])}"),
    ]
    return "| Metric | Value |\n|---|---|\n" + "".join(f"| {k} | {v} |\n" for k, v in rows)


def fmt_summary(facts: dict, limit: int) -> str:
    t = facts["totals"]
    out = [f"# Architecture facts: {facts['root']}", ""]
    out.append(f"- Python: {t['python_files']} files, {t['python_lines']} lines ({t['test_files']} test files); "
               f"{t['classes']} classes, {t['functions']} functions")
    if t["frontend_files"]:
        out.append(f"- Frontend: {t['frontend_files']} files, {t['frontend_lines']} lines")
    out += ["", "## Top-level directories", "", "| dir | py files | py lines | test files | frontend lines |",
            "|---|---|---|---|---|"]
    for row in facts["packages"][:limit]:
        out.append(f"| {row['dir']} | {row['files']} | {row['lines']} | {row['tests']} | {row['frontend_lines']} |")

    def section(title: str, items: list, render) -> None:
        out.extend(["", f"## {title} ({len(items)})", ""])
        if not items:
            out.append("- none")
        for item in items[:limit]:
            out.append(f"- {render(item)}")
        if len(items) > limit:
            out.append(f"- ... {len(items) - limit} more (use `json` for all)")

    section("Syntax errors", facts["syntax_errors"], lambda e: f"`{e['path']}`: {e['error']}")
    section("Package-level import cycles", facts["package_cycles"], lambda c: " <-> ".join(f"`{n}`" for n in c))
    section("Module-level import cycles", facts["module_cycles"], lambda c: " <-> ".join(f"`{n}`" for n in c))
    section("Unresolved internal imports", facts["unresolved_internal_imports"],
            lambda u: f"`{u['path']}:{u['line']}` imports `{u['import']}`")
    section("Imports treated as external although the repository has a package of that name "
            "(missing source root? cycles, importers and unreferenced results are unreliable until checked)",
            facts["suspected_source_roots"],
            lambda r: f"`{r['import_root']}` is imported {r['imports']} times (e.g. `{r['example']}`) "
                      f"but the repository has it under `{r['container']}/`; third-party names that match a "
                      f"directory also show up here")
    fan_in: Counter = Counter()
    fan_out: Counter = Counter()
    for e in facts["package_edges"]:
        fan_in[e["to"]] += 1
        fan_out[e["from"]] += 1
    nodes = sorted(set(fan_in) | set(fan_out), key=lambda n: -(fan_in[n] + fan_out[n]))
    section("Package coupling (fan-in / fan-out)", nodes, lambda n: f"`{n}` in={fan_in[n]} out={fan_out[n]}")
    section("Process-level calls (subprocess, shell scripts)", facts["process_calls"],
            lambda c: f"`{c['path']}:{c['line']}` runs `{c['to']}`")
    section("Core class candidates", [c for c in facts["classes"] if c["weight"] > 0],
            lambda c: f"`{c['module']}.{c['name']}`" + (" (abstract)" if c["abstract"] else "")
                      + f" weight {c['weight']}: {c['subclasses']} subclasses, {len(c['collaborators'])} collaborators, "
                      f"{len(c['public_methods'])} public methods, used by {c['used_by_modules']} modules")
    d = facts["duplicates"]
    section("Identical files", d["identical_files"], lambda g: ", ".join(f"`{p}`" for p in g))
    section("Similar files with the same name", d["similar_files"],
            lambda p: f"`{p['a']}` ~ `{p['b']}` similarity {p['similarity']}")
    section("Copied function bodies", d["functions"],
            lambda g: f"{len(g)} copies, {g[0]['lines']} lines: " + ", ".join(
                f"`{e['path']}:{e['line']}` {e['function']}" for e in g[:4]))
    section("Copies with renamed variables or messages", d["renamed_functions"],
            lambda g: f"{len(g)} copies, {g[0]['lines']} lines: " + ", ".join(
                f"`{e['path']}:{e['line']}` {e['function']}" for e in g[:4]))
    section("File pairs sharing >= 3 copied functions", d["files_sharing_functions"],
            lambda p: f"`{p['a']}` ~ `{p['b']}`: {p['functions']} functions")
    section("Sync/async twins", d["sync_async"],
            lambda g: ", ".join(f"`{e['path']}:{e['line']}` {e['function']}" for e in g[:4]))
    h = facts["hotspots"]
    section(f"Modules >= {BIG_MODULE} lines", h["big_modules"], lambda x: f"`{x['path']}` {x['lines']} lines")
    section(f"Classes >= {BIG_CLASS} lines", h["big_classes"],
            lambda x: f"`{x['path']}:{x['line']}` {x['class']} {x['lines']} lines, {x['methods']} methods")
    section(f"Functions >= {LONG_FUNCTION} lines", h["long_functions"],
            lambda x: f"`{x['path']}:{x['line']}` {x['function']} {x['lines']} lines")
    section(f"Nesting depth >= {DEEP_NESTING}", h["deep_nesting"],
            lambda x: f"`{x['path']}:{x['line']}` {x['function']} depth {x['depth']}")
    section(f"Functions with >= {MANY_PARAMS} parameters", h["many_params"],
            lambda x: f"`{x['path']}:{x['line']}` {x['function']} {x['params']} params")
    big_fe = sorted(facts["frontend"], key=lambda f: -f["lines"])
    section("Frontend files", big_fe, lambda f: f"`{f['path']}` {f['lines']} lines"
            + (f", {f['inline_script_lines']} inline script lines" if f["inline_script_lines"] else ""))
    entries = facts["entry_points"]
    out.extend(["", f"## Entry points (`__main__` guard) ({len(entries)})", ""])
    out.append(", ".join(f"`{p}`" for p in entries[:10]) + (f" … {len(entries) - 10} more" if len(entries) > 10 else "")
               if entries else "- none")
    return "\n".join(out) + "\n"


def mermaid_id(name: str) -> str:
    return "n_" + "".join(ch if ch.isalnum() else "_" for ch in name)


def mermaid_packages(facts: dict, max_nodes: int, focus: str | None) -> str:
    edges = facts["package_edges"]
    if focus:
        edges = [e for e in edges if e["from"].startswith(focus) or e["to"].startswith(focus)]
    weight: Counter = Counter()
    process = [e for e in facts["process_edges"]
               if not focus or e["from"].startswith(focus) or e["to"].startswith(focus)]
    for e in edges:
        weight[e["from"]] += e["imports"]
        weight[e["to"]] += e["imports"]
    for e in process:
        weight[e["from"]] += 1
        weight[e["to"]] += 1
    cyclic = {n for c in facts["package_cycles"] for n in c} & set(weight)
    keep = set(cyclic)
    for n, _ in weight.most_common():
        if len(keep) >= max(max_nodes, len(cyclic)):
            break
        keep.add(n)
    lines = ["flowchart LR"]
    for n in sorted(keep):
        lines.append(f'  {mermaid_id(n)}["{n}"]')
    for e in edges:
        if e["from"] in keep and e["to"] in keep:
            arrow = "-->" if e["imports"] < 5 else "==>"
            lines.append(f"  {mermaid_id(e['from'])} {arrow} {mermaid_id(e['to'])}")
    imported = {(e["from"], e["to"]) for e in edges}
    for e in process:
        if e["from"] in keep and e["to"] in keep and (e["from"], e["to"]) not in imported:
            lines.append(f"  {mermaid_id(e['from'])} -.->|subprocess| {mermaid_id(e['to'])}")
    if cyclic & keep:
        lines.append("  classDef cycle stroke:#d33,stroke-width:2px")
        lines.append("  class " + ",".join(mermaid_id(n) for n in sorted(cyclic & keep)) + " cycle")
    dropped = len(weight) - len(keep)
    if dropped > 0:
        lines.append(f"  %% {dropped} less-connected packages omitted; raise --max-nodes or use --focus")
    return "\n".join(lines) + "\n"


def mermaid_classes(facts: dict, max_nodes: int, focus: str | None) -> str:
    classes = [c for c in facts["classes"] if c["weight"] > 0 and (not focus or c["module"].startswith(focus))]
    chosen = classes[:max_nodes]
    counts = Counter(c["name"] for c in chosen)
    ids = {(c["module"], c["name"]): c["name"] if counts[c["name"]] == 1 else f"{c['name']}_{c['module'].split('.')[-1]}"
           for c in chosen}
    by_name: dict[str, list[dict]] = defaultdict(list)
    for c in chosen:
        by_name[c["name"]].append(c)

    def ref(name: str, near: dict) -> str | None:
        options = by_name.get(name, [])
        best = next((o for o in options if o["module"] == near["module"]), options[0] if options else None)
        return ids[(best["module"], best["name"])] if best else None

    lines = ["classDiagram"]
    for c in chosen:
        lines.append(f"  class {ids[(c['module'], c['name'])]} {{")
        if c["abstract"]:
            lines.append("    <<abstract>>")
        for a in [a for a in c["attributes"] if not a.startswith("_")][:5]:
            lines.append(f"    +{a}")
        for m in c["public_methods"][:6]:
            lines.append(f"    +{m}()")
        lines.append("  }")
    seen: set[tuple[str, str]] = set()
    for c in chosen:
        me = ids[(c["module"], c["name"])]
        for base in c["bases"]:
            parent = ref(base.split(".")[-1].split("[")[0], c)
            if parent and parent != me:
                lines.append(f"  {parent} <|-- {me}")
                seen.add((me, parent))
        typed = {**{k: v for k, v in c["attributes"].items() if v}, **c["init_params"]}
        for attr, annotation in typed.items():
            for name in sorted(type_names(annotation)):
                other = ref(name, c)
                if other and other != me and (me, other) not in seen:
                    seen.add((me, other))
                    lines.append(f"  {me} --> {other} : {attr}")
    dropped = len(classes) - len(chosen)
    if dropped > 0:
        lines.append(f"  %% {dropped} lower-weight classes omitted; use --focus per subsystem")
    return "\n".join(lines) + "\n"


def load_rules(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".json":
        return json.loads(text)
    try:
        import tomllib
    except ModuleNotFoundError:
        sys.exit("rules.toml needs Python 3.11+ (tomllib); or write the same structure as rules.json")
    return tomllib.loads(text)


def matches(name: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(name, p) or name == p.rstrip(".*") for p in patterns)


RULE_KEYS = {"layers", "forbid", "budgets", "no_cycles"}
BUDGET_KEYS = {"max_module_lines", "max_function_lines", "max_params", "max_nesting", "exempt"}


def unknown_rule_keys(rules: dict) -> list[str]:
    unknown = [k for k in rules if k not in RULE_KEYS]
    unknown += [f"budgets.{k}" for k in rules.get("budgets", {}) if k not in BUDGET_KEYS]
    return unknown


def check(index: RepoIndex, facts: dict, rules: dict) -> list[str]:
    violations: list[str] = []
    layers = rules.get("layers", [])

    def layer_of(mod: str) -> int | None:
        for i, layer in enumerate(layers):
            if matches(mod, layer.get("modules", [])):
                return i
        return None

    edge_lines: dict[tuple[str, str], list[str]] = defaultdict(list)
    for mod in index.modules.values():
        for ref in mod.imports:
            if ref.guarded == "TYPE_CHECKING":
                continue
            for target, _ in index.resolve(mod, ref):
                if target and target != mod.name:
                    edge_lines[(mod.name, target)].append(f"{mod.path}:{ref.line}")
    for (a, b), where in sorted(edge_lines.items()):
        la, lb = layer_of(a), layer_of(b)
        if la is not None and lb is not None and lb < la:
            violations.append(f"layer: `{a}` ({layers[la]['name']}) imports `{b}` ({layers[lb]['name']}) "
                              f"which is above it — {where[0]}")
        for rule in rules.get("forbid", []):
            if matches(a, [rule["from"]]) and matches(b, [rule["to"]]):
                reason = f" ({rule['reason']})" if rule.get("reason") else ""
                violations.append(f"forbidden: `{a}` imports `{b}`{reason} — {where[0]}")
    budget = rules.get("budgets", {})
    h_mod = budget.get("max_module_lines")
    h_fn = budget.get("max_function_lines")
    h_par = budget.get("max_params")
    h_nest = budget.get("max_nesting")
    exempt = budget.get("exempt", [])
    for mod in index.modules.values():
        if mod.is_test or matches(mod.name, exempt):
            continue
        if h_mod and mod.lines > h_mod:
            violations.append(f"budget: `{mod.path}` has {mod.lines} lines > {h_mod}")
        for fn in list(mod.functions) + [m for c in mod.classes for m in c.methods]:
            loc = f"`{mod.path}:{fn.line}` {fn.qualname}"
            if h_fn and fn.length > h_fn:
                violations.append(f"budget: {loc} has {fn.length} lines > {h_fn}")
            if h_par and fn.params > h_par:
                violations.append(f"budget: {loc} has {fn.params} params > {h_par}")
            if h_nest and fn.nesting > h_nest:
                violations.append(f"budget: {loc} nesting {fn.nesting} > {h_nest}")
    if rules.get("no_cycles", False):
        for cycle in facts["package_cycles"]:
            violations.append("cycle: " + " <-> ".join(f"`{n}`" for n in cycle))
    return violations


def unlayered(index: RepoIndex, rules: dict, depth: int) -> Counter:
    """Non-test modules that match no layer, counted per package; the layer rules never check them."""
    layers = rules.get("layers", [])
    exempt = rules.get("budgets", {}).get("exempt", [])
    if not layers:
        return Counter()
    dirs = directory_names(index)
    return Counter(collapse(m.name, depth, dirs) for m in index.modules.values()
                   if not m.is_test and not matches(m.name, exempt)
                   and not any(matches(m.name, layer.get("modules", [])) for layer in layers))


def violation_counts(violations: list[str]) -> str:
    kinds = Counter(v.split(":", 1)[0] for v in violations)
    budget_files = {re.search(r"`([^`:]+)", v).group(1) for v in violations if v.startswith("budget:")}
    parts = [f"{k} {kinds[k]}" for k in ("layer", "forbidden", "cycle") if kinds[k]]
    if kinds["budget"]:
        parts.append(f"budget {kinds['budget']} in {len(budget_files)} files")
    return f"{len(violations)} violation(s)" + (": " + ", ".join(parts) if parts else "")


NODE = re.compile(r"""([A-Za-z_][\w-]*)\s*(\[\[|\[\(|\(\[|\(\(|\{\{|\[/|\[\\|\[|\(|\{|>)\s*"?(.*?)"?\s*"""
                  r"""(\]\]|\)\]|\]\)|\)\)|\}\}|/\]|\\\]|\]|\)|\})""")
ARROW = re.compile(r"\s*(<?(?:-{2,}|={2,}|-\.+-)[->ox]?)\s*(\|[^|]*\|)?\s*")
CODE_TOKEN = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+|[\w.-]+(?:/[\w.-]+)+/?")


def mermaid_blocks(path: Path) -> list[tuple[int, str]]:
    text = path.read_text(encoding="utf-8")
    if path.suffix != ".md":
        return [(1, text)]
    return [(text[:m.start()].count("\n") + 2, m.group(1))
            for m in re.finditer(r"^```mermaid\s*\n(.*?)^```", text, re.M | re.S)]


def verify_diagram(index: RepoIndex, facts: dict, source: str) -> list[tuple[int, str]]:
    """Problems in one Mermaid diagram: unknown modules, paths and classes; dependency arrows with no import."""
    modules = set(index.modules)
    prefixes = {".".join(n.split(".")[:i]) for n in modules for i in range(1, n.count(".") + 2)}
    classes: dict[str, list[list[str]]] = defaultdict(list)
    for mod in index.modules.values():
        for cls in mod.classes:
            classes[cls.name].append([b.split(".")[-1].split("[")[0] for b in cls.bases])
    problems: list[tuple[int, str]] = []

    def code_entity(token: str) -> tuple[str | None, bool]:
        """(module or package the token names, whether it names something that exists)."""
        token = token.strip("`'\" ")
        if "/" in token:
            rel = token.strip("/").removeprefix("./")
            if (index.root / rel).exists():
                mod = index.by_path.get(rel)
                return (mod.name if mod else rel.removesuffix("/").replace("/", ".")
                        if rel.replace("/", ".").strip(".") in prefixes else None), True
            return None, rel.split("/")[0] not in index.internal_tops and not (index.root / rel.split("/")[0]).exists()
        if not index.is_internal(token):
            return None, True
        token = index.canonical(token)
        if not token:
            return None, True
        if token in prefixes:
            return token, True
        head, _, attr = token.rpartition(".")
        if head in modules and (attr in index.modules[head].top_names or (index.root / token).exists()):
            return head, True
        return None, (index.root / token).exists()

    def check_label(no: int, label: str) -> str | None:
        """Report unknown names in a label; return the module the label stands for, if it is exactly one."""
        label = re.sub(r"<[^>]+>", "\n", label)
        first = label.strip().splitlines()[0].strip(" `") if label.strip() else ""
        entity = None
        for token in CODE_TOKEN.findall(label):
            name, ok = code_entity(token)
            if not ok:
                problems.append((no, f"`{token}` does not exist in the code"))
            if name and token.strip("`/") == first.strip("/"):
                entity = name
        return entity

    lines = source.splitlines()
    kind = next((l.split()[0] for l in lines if l.strip() and not l.strip().startswith("%%")), "")
    edges = {(e["from"], e["to"]) for e in facts["module_edges"]} | \
        {(c["from"], c["to"]) for c in facts["process_calls"]}

    def depends(a: str, b: str) -> bool:
        under = lambda name, p: name == p or name.startswith(p + ".")  # noqa: E731
        return any(under(x, a) and under(y, b) for x, y in edges)

    if kind in ("flowchart", "graph"):
        entity_of: dict[str, str | None] = {}
        for no, line in enumerate(lines, 1):
            text = line.strip()
            if text.startswith(("%%", "classDef", "class ", "style", "linkStyle", "click")):
                continue
            sub = re.match(r"subgraph\s+([\w-]+)\s*\[\s*\"?(.*?)\"?\s*\]", text)
            if sub:
                entity_of[sub.group(1)] = check_label(no, sub.group(2))
                continue
            for m in NODE.finditer(text):
                entity_of[m.group(1)] = check_label(no, m.group(3))
            bare = NODE.sub(lambda m: m.group(1), text)
            parts = ARROW.split(bare)
            for i in range(0, len(parts) - 3, 3):
                a, arrow, label, b = parts[i].split()[-1:] or [""], parts[i + 1], parts[i + 2], parts[i + 3].split()[:1]
                a, b = a[0] if a else "", b[0] if b else ""
                ea, eb = entity_of.get(a), entity_of.get(b)
                if label or "." in arrow or not ea or not eb or ea == eb:
                    continue
                if arrow.startswith("<"):
                    ea, eb = eb, ea
                if not depends(ea, eb):
                    hint = " (the arrow is reversed)" if depends(eb, ea) else ""
                    problems.append((no, f"`{ea}` does not import `{eb}`{hint}; label runtime links like `-->|HTTP|`"))
    elif kind == "classDiagram":
        for no, line in enumerate(lines, 1):
            text = line.strip()
            for name in re.findall(r"^class\s+([A-Za-z_]\w*)", text):
                if name not in classes and name.rsplit("_", 1)[0] not in classes:
                    problems.append((no, f"class `{name}` does not exist in the code"))
            inherit = re.match(r"([A-Za-z_]\w*)\s*<\|--\s*([A-Za-z_]\w*)", text)
            if inherit:
                parent, child = (n if n in classes else n.rsplit("_", 1)[0] for n in inherit.groups())
                if child in classes and not any(parent in bases for bases in classes[child]):
                    problems.append((no, f"`{child}` does not inherit from `{parent}`"))
            for label in re.findall(r"\[\s*\"(.*?)\"\s*\]", text):
                check_label(no, label)
    else:
        for no, line in enumerate(lines, 1):
            m = re.match(r"\s*(?:participant|actor)\s+\S+\s+as\s+(.*)", line)
            check_label(no, m.group(1) if m else line.split(":", 1)[-1] if ":" in line else "")
    return problems


def verify(index: RepoIndex, facts: dict, target: Path) -> list[str]:
    files = [target] if target.is_file() else sorted(p for p in target.rglob("*") if p.suffix in (".mmd", ".md"))
    out = []
    for path in files:
        rel = path.relative_to(index.root) if path.is_relative_to(index.root) else path
        for start, block in mermaid_blocks(path):
            for no, problem in verify_diagram(index, facts, block):
                out.append(f"`{rel}:{start + no - 1}` {problem}")
    return out


TEXT_SUFFIXES = (".sh", ".bash", ".md", ".rst", ".txt", ".toml", ".cfg", ".ini", ".yaml", ".yml", ".json",
                 ".ipynb", ".html", ".js", ".ts", ".mjs")
TEXT_NAMES = ("Dockerfile", "Makefile", "Procfile", "Justfile")


def importers(index: RepoIndex, target: str, limit: int) -> str:
    """Everything that references a module or package: imports (tests included) and text mentions."""
    target = index.canonical(target.strip().strip("/").replace("/", ".").removesuffix(".py"))
    inside = lambda name: name == target or name.startswith(target + ".")  # noqa: E731
    imports: list[str] = []
    import_lines: set[tuple[str, int]] = set()
    for mod in index.modules.values():
        if inside(mod.name):
            continue
        for ref in mod.imports:
            hits = sorted({t for t, _ in index.resolve(mod, ref) if t and inside(t)})
            if hits or (not any(t for t, _ in index.resolve(mod, ref)) and inside(ref.target)):
                where = f"`{mod.path}:{ref.line}`" + (" (test)" if mod.is_test else "")
                imports.append(f"- {where} imports `{', '.join(hits) or ref.target}`")
                import_lines.add((mod.path, ref.line))
    # Text mentions may spell the module with or without the src/ prefix.
    spellings = {target, f"src.{target}", target.removeprefix("src.")} if index.src_tops else {target}
    as_paths = {s.replace(".", "/") for s in spellings}
    as_path = target.replace(".", "/")
    pattern = re.compile("|".join(
        [rf"(?<![\w.]){re.escape(s)}(?![\w])" for s in sorted(spellings)]
        + [rf"(?<![\w/]){re.escape(p)}(?:\.py|/|\b)" for p in sorted(as_paths)]))
    texts = [(m.path, m.source) for m in index.modules.values() if not inside(m.name)]
    for rel in list(index.other_files) + [f.path for f in index.frontend]:
        p = Path(rel)
        if rel.startswith(as_path + "/") or not (p.suffix.lower() in TEXT_SUFFIXES or p.name in TEXT_NAMES):
            continue
        try:
            if (index.root / rel).stat().st_size < 2_000_000:
                texts.append((rel, (index.root / rel).read_text(encoding="utf-8", errors="replace")))
        except OSError:
            continue
    mentions: list[str] = []
    for rel, text in sorted(texts):
        for no, line in enumerate(text.splitlines(), 1):
            if (rel, no) not in import_lines and pattern.search(line):
                mentions.append(f"- `{rel}:{no}` {line.strip()[:110]}")
    out = [f"# References to `{target}`", "", f"## Python imports ({len(imports)})", ""]
    out += imports[:limit] or ["- none"]
    if len(imports) > limit:
        out.append(f"- ... {len(imports) - limit} more")
    out += ["", f"## Other mentions: strings, scripts, configs, docs ({len(mentions)})", ""]
    out += mentions[:limit] or ["- none"]
    if len(mentions) > limit:
        out.append(f"- ... {len(mentions) - limit} more")
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", nargs="?", default="summary",
                        choices=["summary", "json", "mermaid", "check", "importers", "verify"])
    parser.add_argument("target", nargs="?",
                        help="module, package or path for `importers`; diagram file or directory for `verify` "
                             "(default docs/architecture/diagrams)")
    parser.add_argument("--root", default=".", help="repository root (default: current directory)")
    parser.add_argument("--include", action="append", help="only analyse these paths (repeatable)")
    parser.add_argument("--include-tests", action="store_true", help="count test modules in graphs and classes")
    parser.add_argument("--depth", type=int, default=2,
                        help="dotted parts kept when grouping modules into packages "
                             "(depth 2: pkg.sub.mod -> pkg.sub; a plain module folds into its directory)")
    parser.add_argument("--limit", type=int, default=15, help="items per section in summary")
    parser.add_argument("--view", choices=["packages", "classes"], default="packages")
    parser.add_argument("--max-nodes", type=int, default=15)
    parser.add_argument("--focus", help="dotted module prefix to focus a diagram on")
    parser.add_argument("--rules", default=".clean-arch/rules.toml")
    parser.add_argument("--brief", action="store_true", help="summary as a short metrics table")
    args = parser.parse_args(argv)
    if args.command == "importers" and not args.target:
        parser.error("importers needs a target, e.g. `importers pkg.sub` or `importers pkg/sub`")

    root = Path(args.root).resolve()
    index = build_index(root, args.include)
    if args.command == "importers":
        print(importers(index, args.target, max(args.limit, 60)), end="")
        return 0
    facts = collect(index, args.include_tests, args.depth)
    if args.command == "verify":
        target = Path(args.target or "docs/architecture/diagrams")
        target = target if target.is_absolute() else root / target
        if not target.exists():
            parser.error(f"{target} does not exist")
        problems = verify(index, facts, target)
        for p in problems:
            print(f"- {p}")
        print(f"{len(problems)} problem(s)")
        return 1 if problems else 0
    if args.command == "json":
        print(json.dumps(facts, indent=1, ensure_ascii=False))
    elif args.command == "mermaid":
        render = mermaid_packages if args.view == "packages" else mermaid_classes
        print(render(facts, args.max_nodes, args.focus), end="")
    elif args.command == "check":
        rules_path = Path(args.rules)
        rules_path = rules_path if rules_path.is_absolute() else root / rules_path
        if not rules_path.exists():
            print(f"no rules file at {rules_path}; nothing to check")
            return 0
        rules = load_rules(rules_path)
        for key in unknown_rule_keys(rules):
            print(f"warning: unknown rules key `{key}` is ignored (top-level keys must precede the first [table])",
                  file=sys.stderr)
        violations = check(index, facts, rules)
        for v in violations:
            print(f"- {v}")
        print(violation_counts(violations))
        loose = unlayered(index, rules, args.depth)
        if loose:
            print(f"note: {sum(loose.values())} modules match no layer and are not layer-checked: "
                  + ", ".join(f"{p} ({n})" for p, n in loose.most_common(12)))
        return 1 if violations else 0
    elif args.brief:
        print(fmt_brief(facts), end="")
    else:
        print(fmt_summary(facts, args.limit), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
