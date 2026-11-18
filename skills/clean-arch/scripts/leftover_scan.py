#!/usr/bin/env python3
"""Find what a refactor should not leave behind.

Categories (severity in brackets):
  parallel-version   [high]   foo.py next to foo_v2.py / foo_new.py, Thing and ThingV2, copied files
  duplicate          [high]   identical function bodies or files in two places
  broken-import      [high]   internal import that no longer resolves
  compat-shim        [high]   aliases, forwarding modules, deprecation wrappers, ImportError fallbacks, legacy flags
  commented-code     [medium] blocks of commented-out code
  debug              [medium] breakpoint(), pdb, console.log, debugger ([low] for print() in library code)
  version-name       [medium] identifiers or files named *_old, *_new, *_tmp, legacy_*, *_backup ...
  narrative-comment  [low]    comments that describe the edit history instead of the code
  unreferenced       [low]    top-level function/class/module that nothing references
  todo               [info]   TODO/FIXME/XXX/HACK

Usage:
  leftover_scan.py [--root .] [--since REF] [--include PATH ...] [--format md|json] [--fail-on high]

Exit code is 0 unless --fail-on is given and a finding at or above that severity remains.

With --since, findings are limited to files changed since REF (plus untracked files),
but references and duplicates are still resolved against the whole repository.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
import sys
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pyindex import RepoIndex, build_index, comment_tokens, ensure_utf8_stdio  # noqa: E402

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2, "info": 3}

VERSION_WORD = r"(?:old|new|legacy|deprecated|bak|backup|copy|tmp|temp|orig|unused|draft|wip|v\d+)"
VERSION_IDENT = re.compile(
    rf"^{VERSION_WORD}_|_{VERSION_WORD}$|^(?:Old|New|Legacy|Tmp|Temp)[A-Z]|[a-z0-9](?:V\d+|Old|New|Legacy|Tmp|Backup|Copy)$")
VERSION_FILE = re.compile(rf"(?:^{VERSION_WORD}[_\-.]|[_\-.]{VERSION_WORD}$)", re.I)
NARRATIVE = re.compile(
    r"\b(changed|updated|modified|refactored|rewritten|replaced|renamed|moved|now (?:uses|use|we|it)|previously|"
    r"no longer|used to|was:|old:|new:|added for|removed|for now|temporar(?:y|ily)|quick fix|workaround|"
    r"keep (?:for|until)|backward[s]? compat\w*|legacy|deprecated)\b"
    r"|修改|改为|改成|改用|新增|已删除|删除了|原来|之前的|旧版|新版|旧的|新的实现|临时|先这样|暂时|保留以|过渡|迁自|迁移自|上移自",
    re.I,
)
COMPAT_COMMENT = re.compile(r"backward[s]?[ -]?compat|for compatibility|compat(?:ibility)? (?:shim|layer|alias)|兼容(?:旧|老|层|性)|过渡", re.I)
LEGACY_PARAM = re.compile(r"^(?:legacy|compat|use_old|old|use_legacy|use_new|new)_|_(?:legacy|compat)$")
TODO = re.compile(r"\b(TODO|FIXME|XXX|HACK)\b")
CODE_HINT = re.compile(r"(\w+\s*=[^=]|\w+\(.*\)|^\s*(?:import|from|return|def|class|if|for|while|with|raise|print)\b|\[.*\]|\.\w+\()")
REGISTRY_DECORATORS = re.compile(r"(route|get|post|put|delete|patch|fixture|command|group|register|task|hookimpl|"
                                 r"callback|validator|field_validator|model_validator|property|cached_property|"
                                 r"setter|abstractmethod|staticmethod|classmethod|override|app\.|router\.)", re.I)
CLI_HINT = re.compile(r"\bargparse\b|\bclick\b|\btyper\b|\bfire\b")


@dataclass
class Finding:
    category: str
    severity: str
    path: str
    line: int
    message: str
    related: tuple[str, ...] = ()


def changed_files(root: Path, since: str) -> set[str]:
    def git(*args: str) -> list[str]:
        out = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
        if out.returncode != 0:
            sys.exit(f"git {' '.join(args)} failed: {out.stderr.strip()}")
        return [ln for ln in out.stdout.splitlines() if ln]
    files = set(git("diff", "--name-only", f"{since}"))
    files |= set(git("ls-files", "--others", "--exclude-standard"))
    return files


def scan_version_names(index: RepoIndex, out: list[Finding]) -> None:
    stems: dict[tuple[str, str], list[str]] = defaultdict(list)
    for rel in list(index.by_path) + [f.path for f in index.frontend]:
        p = Path(rel)
        stem = p.stem
        if VERSION_FILE.search(stem) and not stem.startswith("test_"):
            base = VERSION_FILE.sub("_", stem).strip("_-.")
            stems[(p.parent.as_posix(), base)].append(rel)
            out.append(Finding("version-name", "medium", rel, 1, f"file name `{p.name}` looks like a version marker"))
    for (parent, base), files in stems.items():
        for suffix in (".py", ".js", ".ts", ".html", ".css"):
            original = f"{base}{suffix}" if parent == "." else f"{parent}/{base}{suffix}"
            if original in index.by_path or any(f.path == original for f in index.frontend):
                out.append(Finding("parallel-version", "high", files[0], 1,
                                   f"`{files[0]}` coexists with `{original}`; keep one implementation"))
    for mod in index.modules.values():
        if mod.tree is None:
            continue
        names: dict[str, int] = {}
        for node in ast.walk(mod.tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.setdefault(node.name, node.lineno)
        # Three or more `x_v1, x_v2, ...` siblings are a family of formats, not leftover copies.
        families: dict[str, int] = defaultdict(int)
        for name in names:
            match = re.match(r"^(.*?)_?[vV]\d+(?:_\w+)?$", name)
            if match:
                families[match.group(1)] += 1
        for name, line in names.items():
            core = name.strip("_")
            if not core or not VERSION_IDENT.search(core):
                continue
            family = re.match(r"^(.*?)_?[vV]\d+(?:_\w+)?$", name)
            if family and families[family.group(1)] >= 3:
                continue
            base = re.sub(rf"(?:_{VERSION_WORD}$|^{VERSION_WORD}_|(?<=[a-z0-9])(?:V\d+|Old|New|Legacy|Tmp|Backup|Copy)$"
                          rf"|^(?:Old|New|Legacy|Tmp|Temp)(?=[A-Z]))", "", core)
            if base and base != core and (base in names or f"_{base}" in names):
                out.append(Finding("parallel-version", "high", mod.path, line,
                                   f"`{name}` coexists with `{base}` in the same module; keep one"))
            else:
                out.append(Finding("version-name", "medium", mod.path, line,
                                   f"`{name}` is named like a temporary or versioned copy"))


def scan_duplicates(index: RepoIndex, out: list[Finding]) -> None:
    contents: dict[str, list[str]] = defaultdict(list)
    for rel in list(index.by_path) + [f.path for f in index.frontend]:
        text = (index.root / rel).read_text(encoding="utf-8", errors="replace")
        norm = "\n".join(ln.strip() for ln in text.splitlines() if ln.strip())
        if len(norm) > 200:
            contents[Path(rel).suffix + norm].append(rel)
    identical_group: dict[str, int] = {}
    for number, group in enumerate(g for g in contents.values() if len(g) > 1):
        identical_group.update((rel, number) for rel in group)
        others = ", ".join(f"`{g}`" for g in group[1:])
        out.append(Finding("parallel-version", "high", group[0], 1, f"file is identical to {others}",
                           tuple(group[1:])))
    by_hash: dict[str, list[tuple[str, str, int, int]]] = defaultdict(list)
    for mod in index.modules.values():
        for fn in list(mod.functions) + [m for c in mod.classes for m in c.methods]:
            if fn.statements >= 6:
                by_hash[fn.body_hash].append((mod.path, fn.qualname, fn.line, fn.length))
    for group in by_hash.values():
        if len(group) < 2:
            continue
        files = {identical_group.get(p, p) for p, _, _, _ in group}
        if len(files) == 1 and group[0][0] in identical_group:
            continue
        path, qual, line, length = group[0]
        others = ", ".join(f"`{p}:{ln}` {q}" for p, q, ln, _ in group[1:])
        out.append(Finding("duplicate", "high", path, line,
                           f"{qual} ({length} lines) has the same body as {others}",
                           tuple(p for p, _, _, _ in group[1:])))


def scan_broken_imports(index: RepoIndex, out: list[Finding]) -> None:
    for mod in index.modules.values():
        for ref in mod.imports:
            if ref.guarded == "TYPE_CHECKING":
                continue
            for target, name in index.resolve(mod, ref):
                if not target:
                    out.append(Finding("broken-import", "high", mod.path, ref.line,
                                       f"imports `{name}`, which does not exist in this repository"))
                elif name is not None:
                    owner = index.modules[target]
                    if name not in owner.top_names and not owner.is_package_init:
                        out.append(Finding("broken-import", "high", mod.path, ref.line,
                                           f"imports `{name}` from `{target}`, which does not define it"))


def _is_alias_assignment(stmt: ast.stmt, defined: set[str]) -> tuple[str, str] | None:
    if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
        value = stmt.value
        target = stmt.targets[0].id
        if isinstance(value, ast.Name) and value.id in defined and target != value.id \
                and not target.isupper() and target not in ("__all__",):
            return target, value.id
    return None


def _is_forwarding_module(mod, index: RepoIndex) -> bool:
    if mod.is_package_init or mod.is_test or not mod.tree or not mod.tree.body:
        return False
    body = list(mod.tree.body)
    if isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
        body = body[1:]
    has_internal_import = False
    for stmt in body:
        if isinstance(stmt, ast.ImportFrom):
            if stmt.level or index.is_internal(stmt.module or ""):
                has_internal_import = True
            elif stmt.module != "__future__":
                return False
        elif isinstance(stmt, ast.Assign) and all(isinstance(t, ast.Name) and t.id == "__all__" for t in stmt.targets):
            continue
        else:
            return False
    return has_internal_import


def scan_compat(index: RepoIndex, out: list[Finding]) -> None:
    for mod in index.modules.values():
        if mod.tree is None:
            continue
        defined = {n.name for n in mod.tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
        imported = set()
        for ref in mod.imports:
            imported.update(ref.alias_map)
        for stmt in mod.tree.body:
            alias = _is_alias_assignment(stmt, defined | imported)
            if alias:
                out.append(Finding("compat-shim", "high", mod.path, stmt.lineno,
                                   f"`{alias[0]} = {alias[1]}` keeps a second name for the same object"))
            if isinstance(stmt, (ast.FunctionDef,)) and stmt.name == "__getattr__":
                out.append(Finding("compat-shim", "high", mod.path, stmt.lineno,
                                   "module-level `__getattr__` usually forwards removed names"))
        if _is_forwarding_module(mod, index):
            out.append(Finding("compat-shim", "high", mod.path, 1,
                               "module only re-exports names from other internal modules: import from the source "
                               "and delete this module"))
        for ref in mod.imports:
            if ref.guarded == "try-except-ImportError" and index.is_internal(ref.target):
                out.append(Finding("compat-shim", "high", mod.path, ref.line,
                                   f"internal import of `{ref.target}` wrapped in try/except ImportError"))
        for node in ast.walk(mod.tree):
            if isinstance(node, ast.Call):
                text = ast.unparse(node.func)
                if text.endswith("warn") and any("Deprecat" in ast.unparse(a) for a in node.args + [k.value for k in node.keywords]):
                    out.append(Finding("compat-shim", "high", mod.path, node.lineno,
                                       "emits a DeprecationWarning: remove the old path instead"))
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if any("deprecat" in d.lower() for d in (ast.unparse(x) for x in node.decorator_list)):
                    out.append(Finding("compat-shim", "high", mod.path, node.lineno,
                                       f"`{node.name}` is marked deprecated"))
                for arg in node.args.args + node.args.kwonlyargs:
                    if LEGACY_PARAM.search(arg.arg):
                        out.append(Finding("compat-shim", "high", mod.path, node.lineno,
                                           f"`{node.name}` takes legacy switch `{arg.arg}`"))
        for line, text in comment_tokens(mod.source):
            if COMPAT_COMMENT.search(text):
                out.append(Finding("compat-shim", "high", mod.path, line, f"compatibility comment: {text.strip()[:90]}"))


def _looks_like_code(block: list[str]) -> bool:
    body = "\n".join(block)
    if not CODE_HINT.search(body):
        return False
    stripped = [ln for ln in block if ln.strip()]
    if not stripped:
        return False
    if all(re.fullmatch(r"[\w\u4e00-\u9fff\s,.:;!?'\"()\-]+", ln) and "(" not in ln and "=" not in ln for ln in stripped):
        return False
    import textwrap
    try:
        ast.parse(textwrap.dedent(body))
        return True
    except SyntaxError:
        try:
            ast.parse(textwrap.dedent(body) + "\n    pass")
            return True
        except SyntaxError:
            return False


def scan_comments(index: RepoIndex, out: list[Finding]) -> None:
    for mod in index.modules.values():
        comments = comment_tokens(mod.source)
        block: list[tuple[int, str]] = []

        def flush() -> None:
            if not block:
                return
            texts = [t for _, t in block]
            if _looks_like_code(texts):
                out.append(Finding("commented-code", "medium", mod.path, block[0][0],
                                   f"{len(block)} line(s) of commented-out code: `{texts[0].strip()[:60]}`"))
            block.clear()

        lines = mod.source.splitlines()
        prev = -2
        for line, text in comments:
            body = text.lstrip("#").strip()
            whole_line = lines[line - 1].strip().startswith("#") if line - 1 < len(lines) else False
            if text.startswith("#!") or "noqa" in text or "type:" in text or "pragma" in text or "fmt:" in text:
                continue
            if TODO.search(body):
                out.append(Finding("todo", "info", mod.path, line, body[:100]))
            if NARRATIVE.search(body) and not COMPAT_COMMENT.search(body):
                out.append(Finding("narrative-comment", "low", mod.path, line, body[:100]))
            if whole_line:
                if line != prev + 1:
                    flush()
                block.append((line, text.lstrip("#")))
                prev = line
            else:
                flush()
        flush()
    for fe in index.frontend:
        text = (index.root / fe.path).read_text(encoding="utf-8", errors="replace")
        for i, ln in enumerate(text.splitlines(), 1):
            s = ln.strip()
            if re.match(r"^//\s*(const|let|var|function|return|if|for|await|import|export|\w+\(.*\);?$|\w+\.\w+)", s):
                out.append(Finding("commented-code", "medium", fe.path, i, f"commented-out code: `{s[:60]}`"))
            if s.startswith(("//", "/*", "*", "<!--")):
                if NARRATIVE.search(s):
                    out.append(Finding("narrative-comment", "low", fe.path, i, s[:100]))
                if TODO.search(s):
                    out.append(Finding("todo", "info", fe.path, i, s[:100]))


def scan_debug(index: RepoIndex, out: list[Finding]) -> None:
    for mod in index.modules.values():
        if mod.tree is None:
            continue
        cli_like = mod.is_test or mod.has_main_guard or bool(CLI_HINT.search(mod.source)) \
            or mod.path.startswith(("scripts/", "bin/", "tools/", "examples/"))
        for node in ast.walk(mod.tree):
            if isinstance(node, ast.Call):
                fn = ast.unparse(node.func)
                if fn in ("breakpoint", "pdb.set_trace", "ipdb.set_trace", "pudb.set_trace"):
                    out.append(Finding("debug", "medium", mod.path, node.lineno, f"`{fn}()` left in code"))
                elif fn == "print" and not cli_like:
                    out.append(Finding("debug", "low", mod.path, node.lineno,
                                       "`print()` in library code: use logging or return the value"))
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                names = [a.name for a in node.names] + ([node.module] if isinstance(node, ast.ImportFrom) and node.module else [])
                if any(n in ("pdb", "ipdb", "pudb") for n in names):
                    out.append(Finding("debug", "medium", mod.path, node.lineno, "debugger import left in code"))
    for fe in index.frontend:
        text = (index.root / fe.path).read_text(encoding="utf-8", errors="replace")
        for i, ln in enumerate(text.splitlines(), 1):
            s = ln.strip()
            if s.startswith("//"):
                continue
            if re.search(r"\bconsole\.(log|debug)\(", s) or re.match(r"debugger;?$", s):
                out.append(Finding("debug", "medium", fe.path, i, f"`{s[:60]}`"))


def scan_unreferenced(index: RepoIndex, out: list[Finding]) -> None:
    words: dict[str, set[str]] = defaultdict(set)
    word_re = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
    texts: dict[str, str] = {}
    for rel in index.by_path:
        texts[rel] = index.by_path[rel].source
    for rel in index.other_files:
        if Path(rel).suffix.lower() in (".toml", ".cfg", ".ini", ".yaml", ".yml", ".json", ".sh", ".md", ".txt", ".ipynb"):
            try:
                if (index.root / rel).stat().st_size < 2_000_000:
                    texts[rel] = (index.root / rel).read_text(encoding="utf-8", errors="replace")
            except OSError:
                pass
    for fe in index.frontend:
        texts[fe.path] = (index.root / fe.path).read_text(encoding="utf-8", errors="replace")
    for rel, text in texts.items():
        for w in set(word_re.findall(text)):
            words[w].add(rel)
    for mod in index.modules.values():
        if mod.tree is None or mod.is_test or mod.is_package_init:
            continue
        exported = set(mod.all_names or [])
        for node in mod.tree.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            name = node.name
            if name.startswith("__") or name in exported or name in ("main", "cli", "app"):
                continue
            decos = " ".join(ast.unparse(d) for d in node.decorator_list)
            if decos and REGISTRY_DECORATORS.search(decos):
                continue
            uses_elsewhere = words.get(name, set()) - {mod.path}
            uses_here = len(re.findall(rf"\b{re.escape(name)}\b", mod.source))
            if not uses_elsewhere and uses_here <= 1:
                kind = "class" if isinstance(node, ast.ClassDef) else "function"
                out.append(Finding("unreferenced", "low", mod.path, node.lineno,
                                   f"{kind} `{name}` is not referenced anywhere in the repository"))
    imported_modules: set[str] = set()
    for mod in index.modules.values():
        for ref in mod.imports:
            for target, _ in index.resolve(mod, ref):
                if target:
                    imported_modules.add(target)
                    parts = target.split(".")
                    imported_modules.update(".".join(parts[:i]) for i in range(1, len(parts)))
    all_text = "\n".join(t for r, t in texts.items() if not r.endswith(".py"))
    for mod in index.modules.values():
        if mod.is_test or mod.is_package_init or mod.has_main_guard or mod.name in imported_modules:
            continue
        stem = Path(mod.path).stem
        if mod.path in all_text or mod.name in all_text or stem in ("conftest", "setup", "manage", "wsgi", "asgi"):
            continue
        out.append(Finding("unreferenced", "low", mod.path, 1, "module is never imported and is not an entry point"))


def sanity_warnings(index: RepoIndex, findings: list[Finding]) -> list[str]:
    """Signs that the import graph is incomplete, which makes `unreferenced` findings unreliable."""
    warnings = []
    roots = index.suspected_source_roots()
    if roots:
        names = ", ".join(f"`{r['import_root']}` ({r['imports']}x, under `{r['container']}/`)" for r in roots[:5])
        warnings.append(f"imports treated as external although the repository has a package of that name: {names}. "
                        "If these are internal, the import graph is missing edges: check with `rg` before trusting "
                        "`unreferenced`, cycles or importers.")
    candidates = [m for m in index.modules.values() if not m.is_test and not m.is_package_init and not m.has_main_guard]
    never = {f.path for f in findings if f.category == "unreferenced" and "never imported" in f.message}
    if len(candidates) >= 8 and len(never) / len(candidates) >= 0.5:
        warnings.append(f"{len(never)} of {len(candidates)} modules are reported as never imported. That is rarely "
                        "true: pick three of them and run `rg` for their import lines before trusting this list.")
    return warnings


def render_md(findings: list[Finding], limit: int, warnings: list[str] | None = None) -> str:
    banner = "".join(f"> Warning: {w}\n" for w in warnings or [])
    banner += "\n" if banner else ""
    if not findings:
        return banner + "No leftovers found.\n"
    by_cat: dict[str, list[Finding]] = defaultdict(list)
    for f in findings:
        by_cat[f.category].append(f)
    counts = ", ".join(f"{sev}: {sum(1 for f in findings if f.severity == sev)}" for sev in SEVERITY_ORDER)
    lines = [f"# Leftover scan: {len(findings)} finding(s) ({counts})", ""]
    for cat, items in sorted(by_cat.items(), key=lambda kv: (SEVERITY_ORDER[kv[1][0].severity], kv[0])):
        severities = "/".join(sev for sev in SEVERITY_ORDER if any(f.severity == sev for f in items))
        lines.append(f"## {cat} [{severities}] ({len(items)})")
        lines.append("")
        for f in items[:limit]:
            lines.append(f"- `{f.path}:{f.line}` {f.message}")
        if len(items) > limit:
            lines.append(f"- ... {len(items) - limit} more")
        lines.append("")
    return banner + "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ensure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=".")
    parser.add_argument("--since", help="only report files changed since this git ref")
    parser.add_argument("--include", action="append", help="only report findings under these paths")
    parser.add_argument("--skip", action="append", default=[], help="categories to skip (repeatable)")
    parser.add_argument("--format", choices=["md", "json"], default="md")
    parser.add_argument("--limit", type=int, default=25, help="items per category in Markdown output")
    parser.add_argument("--fail-on", choices=["high", "medium", "low", "info", "never"], default="never")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    index = build_index(root)
    findings: list[Finding] = []
    scanners = {
        "version-name": scan_version_names, "duplicate": scan_duplicates, "broken-import": scan_broken_imports,
        "compat-shim": scan_compat, "commented-code": scan_comments, "debug": scan_debug,
        "unreferenced": scan_unreferenced,
    }
    for name, scanner in scanners.items():
        if name not in args.skip:
            scanner(index, findings)
    findings = [f for f in findings if f.category not in args.skip]
    warnings = sanity_warnings(index, findings)
    if args.since:
        scope = changed_files(root, args.since)
        findings = [f for f in findings if f.path in scope or scope.intersection(f.related)]
    if args.include:
        prefixes = [p.replace("\\", "/").rstrip("/") for p in args.include]
        findings = [f for f in findings
                    if any(q == p or q.startswith(p + "/") for p in prefixes for q in (f.path, *f.related))]
    seen = set()
    unique = []
    for f in sorted(findings, key=lambda f: (SEVERITY_ORDER[f.severity], f.category, f.path, f.line)):
        key = (f.category, f.path, f.line, f.message)
        if key not in seen:
            seen.add(key)
            unique.append(f)
    if args.format == "json":
        print(json.dumps([asdict(f) for f in unique], indent=1, ensure_ascii=False))
        for warning in warnings:
            print(f"warning: {warning}", file=sys.stderr)
    else:
        print(render_md(unique, args.limit, warnings), end="")
    if args.fail_on == "never":
        return 0
    threshold = SEVERITY_ORDER[args.fail_on]
    return 1 if any(SEVERITY_ORDER[f.severity] <= threshold for f in unique) else 0


if __name__ == "__main__":
    sys.exit(main())
