"""Static index of a repository: source files, Python modules, imports and definitions.

Shared by arch_facts.py and leftover_scan.py. Standard library only, Python 3.9+.
Nothing here imports or executes the code being analysed.
"""

from __future__ import annotations

import ast
import hashlib
import os
import re
import subprocess
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", "env",
    "build", "dist", "site-packages", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".tox", ".idea", ".vscode", ".clean-arch", ".opencode", ".eggs",
}
FRONTEND_EXT = {".html", ".htm", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".css", ".scss"}
MAX_SOURCE_BYTES = 1_500_000

TEST_PATTERN = re.compile(r"(^|/)(tests?|testing)(/|$)|(^|/)test_[^/]*\.py$|_test\.py$|(^|/)conftest\.py$")
COMPOUND = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.With, ast.AsyncWith, ast.Try)
if hasattr(ast, "TryStar"):
    COMPOUND = COMPOUND + (ast.TryStar,)
if hasattr(ast, "Match"):
    COMPOUND = COMPOUND + (ast.Match,)


@dataclass
class FunctionInfo:
    name: str
    qualname: str
    line: int
    end_line: int
    params: int
    nesting: int
    statements: int
    is_async: bool
    decorators: list[str]
    body_hash: str
    loose_hash: str
    shape_hash: str

    @property
    def length(self) -> int:
        return self.end_line - self.line + 1


@dataclass
class ClassInfo:
    name: str
    line: int
    end_line: int
    bases: list[str]
    decorators: list[str]
    methods: list[FunctionInfo] = field(default_factory=list)
    attributes: dict[str, str] = field(default_factory=dict)
    init_params: dict[str, str] = field(default_factory=dict)
    abstract: bool = False

    @property
    def length(self) -> int:
        return self.end_line - self.line + 1


@dataclass
class ImportRef:
    line: int
    target: str
    names: list[str]
    alias_map: dict[str, str]
    is_from: bool
    level: int
    guarded: str | None


@dataclass
class Module:
    name: str
    path: str
    lines: int
    code_lines: int
    is_package_init: bool
    is_test: bool
    has_main_guard: bool
    tree: ast.Module | None
    source: str
    syntax_error: str | None = None
    imports: list[ImportRef] = field(default_factory=list)
    functions: list[FunctionInfo] = field(default_factory=list)
    classes: list[ClassInfo] = field(default_factory=list)
    top_names: set[str] = field(default_factory=set)
    all_names: list[str] | None = None


@dataclass
class FrontendFile:
    path: str
    lines: int
    imports: list[str]
    inline_script_lines: int


@dataclass
class RepoIndex:
    root: Path
    modules: dict[str, Module]
    by_path: dict[str, Module]
    frontend: list[FrontendFile]
    other_files: list[str]
    internal_tops: set[str]
    # src/ layout: modules under src/ are named the way the repository imports them, either
    # `pkg.mod` (src is a path-only directory) or `src.pkg.mod`; `canonical` accepts both spellings.
    src_prefixed: bool = False
    src_tops: set[str] = field(default_factory=set)

    def canonical(self, dotted: str) -> str:
        """Rewrite a dotted name written with or without the `src.` prefix into this index's spelling."""
        if not self.src_tops:
            return dotted
        first = dotted.split(".")[0]
        if self.src_prefixed:
            return f"src.{dotted}" if first in self.src_tops and first != "src" else dotted
        if first == "src" and "src" not in self.internal_tops:
            return dotted[4:]
        return dotted

    def is_internal(self, dotted: str) -> bool:
        """True when the dotted name starts at a package or module of this repository."""
        first = dotted.split(".")[0]
        if self.src_tops and first == "src":
            return True
        return self.canonical(dotted).split(".")[0] in self.internal_tops

    def suspected_source_roots(self) -> list[dict]:
        """Absolute imports treated as external although a package or module of that name sits deeper in the tree.

        Typical cause: code lives under `backend/pkg/` and runs with `backend` on PYTHONPATH, so the imports
        read `from pkg import x`. Every such import is missing from the graph, which makes modules look
        unreferenced and hides cycles. Third-party names that happen to match a directory also show up here.
        """
        nested: dict[str, Counter] = defaultdict(Counter)
        for mod in self.modules.values():
            parts = list(Path(mod.path).with_suffix("").parts)
            if parts[-1] == "__init__":
                parts = parts[:-1]
            for k in range(1, len(parts)):
                nested[parts[k]]["/".join(parts[:k])] += 1
        counts: Counter = Counter()
        example: dict[str, str] = {}
        for mod in self.modules.values():
            for ref in mod.imports:
                if ref.level or not ref.target or self.is_internal(ref.target):
                    continue
                first = ref.target.split(".")[0]
                if first in nested:
                    counts[first] += 1
                    example.setdefault(first, f"{mod.path}:{ref.line}")
        return [{"import_root": name, "container": nested[name].most_common(1)[0][0], "imports": n,
                 "example": example[name]} for name, n in counts.most_common()]

    def resolve(self, importer: Module, ref: ImportRef) -> list[tuple[str, str | None]]:
        """Map an import to (internal module, imported name or None) pairs."""
        base = ref.target if ref.level else self.canonical(ref.target)
        if ref.level:
            pkg_parts = importer.name.split(".")
            if not importer.is_package_init:
                pkg_parts = pkg_parts[:-1]
            if ref.level - 1 > len(pkg_parts):
                return []
            pkg_parts = pkg_parts[: len(pkg_parts) - (ref.level - 1)]
            base = ".".join([p for p in pkg_parts + ([ref.target] if ref.target else []) if p])
        if not base and self.src_tops and ref.is_from and not ref.level and ref.target == "src":
            return [(name, None) if name in self.modules else ("", name) for name in ref.names]
        if not base:
            return []
        if base.split(".")[0] not in self.internal_tops:
            return []
        results: list[tuple[str, str | None]] = []
        if ref.is_from:
            for name in ref.names:
                candidate = f"{base}.{name}"
                if candidate in self.modules:
                    results.append((candidate, None))
                else:
                    owner = self._longest_module(base)
                    results.append((owner, name) if owner else ("", f"{base}.{name}"))
        else:
            owner = self._longest_module(base)
            results.append((owner, None) if owner else ("", base))
        return results

    def _longest_module(self, dotted: str) -> str | None:
        parts = self.canonical(dotted).split(".")
        for i in range(len(parts), 0, -1):
            candidate = ".".join(parts[:i])
            if candidate in self.modules:
                return candidate
        return None


def list_files(root: Path) -> list[str]:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-co", "--exclude-standard"],
            capture_output=True, text=True, check=True,
        ).stdout
        files = [f for f in out.splitlines() if f]
        files = [f for f in files if not any(part in SKIP_DIRS for part in Path(f).parts)]
        return sorted(f for f in files if (root / f).is_file())
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            found.append(Path(os.path.relpath(os.path.join(dirpath, fn), root)).as_posix())
    return sorted(found)


def module_name(rel: str) -> str:
    parts = list(Path(rel).with_suffix("").parts)
    if parts and parts[0] == "src" and len(parts) > 1:
        parts = parts[1:]
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts) if parts else "__root__"


def decorator_name(node: ast.expr) -> str:
    target = node.func if isinstance(node, ast.Call) else node
    try:
        return ast.unparse(target)
    except Exception:
        return "?"


def nesting_depth(body: list[ast.stmt]) -> int:
    best = 0
    for stmt in body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if isinstance(stmt, COMPOUND):
            children: list[list[ast.stmt]] = []
            for attr in ("body", "orelse", "finalbody"):
                children.append(getattr(stmt, attr, []) or [])
            for handler in getattr(stmt, "handlers", []) or []:
                children.append(handler.body)
            for case in getattr(stmt, "cases", []) or []:
                children.append(case.body)
            best = max(best, 1 + max((nesting_depth(c) for c in children), default=0))
    return best


def count_statements(body: list[ast.stmt]) -> int:
    total = 0
    for node in body:
        for sub in ast.walk(node):
            if isinstance(sub, ast.stmt):
                total += 1
    return total


class _StripAsync(ast.NodeTransformer):
    """Normalise async code so a sync/async copy pair hashes the same."""

    def visit_Await(self, node: ast.Await) -> ast.AST:
        return self.visit(node.value)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> ast.AST:
        self.generic_visit(node)
        return ast.For(target=node.target, iter=node.iter, body=node.body, orelse=node.orelse)

    def visit_AsyncWith(self, node: ast.AsyncWith) -> ast.AST:
        self.generic_visit(node)
        return ast.With(items=node.items, body=node.body)

    def visit_Name(self, node: ast.Name) -> ast.AST:
        return ast.Name(id=re.sub(r"^(async_?|Async)", "", node.id), ctx=node.ctx)

    def visit_Attribute(self, node: ast.Attribute) -> ast.AST:
        self.generic_visit(node)
        node.attr = re.sub(r"^(a(?=[a-z]{3})|async_?)", "", node.attr)
        return node


class _RenameLocals(ast.NodeTransformer):
    """Rename parameters and local variables by first appearance and blank string literals,
    so a copy whose locals or messages were renamed still hashes the same."""

    def __init__(self, local_names: set[str]):
        self.local_names = local_names
        self.mapping: dict[str, str] = {}

    def visit_Name(self, node: ast.Name) -> ast.AST:
        if node.id in self.local_names:
            node.id = self.mapping.setdefault(node.id, f"_v{len(self.mapping)}")
        return node

    def visit_Constant(self, node: ast.Constant) -> ast.AST:
        if isinstance(node.value, str):
            return ast.Constant(value="")
        return node


def _local_names(node: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    args = node.args
    names = {a.arg for a in args.posonlyargs + args.args + args.kwonlyargs}
    names |= {a.arg for a in (args.vararg, args.kwarg) if a}
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Store):
            names.add(sub.id)
        elif isinstance(sub, (ast.Global, ast.Nonlocal)):
            names -= set(sub.names)
    return names


def _digest(stmts: list[ast.AST]) -> str:
    return hashlib.sha1("".join(ast.dump(s) for s in stmts).encode()).hexdigest()[:16]


def _body_hashes(node: ast.FunctionDef | ast.AsyncFunctionDef) -> tuple[str, str, str]:
    body = node.body
    if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) \
            and isinstance(body[0].value.value, str):
        body = body[1:]
    fresh = lambda: [ast.parse(ast.unparse(s)).body[0] for s in body]  # noqa: E731
    loose_body = [_StripAsync().visit(s) for s in fresh()]
    renamer = _RenameLocals(_local_names(node))
    shape_body = [renamer.visit(s) for s in fresh()]
    return _digest(body), _digest(loose_body), _digest(shape_body)


def _function_info(node: ast.FunctionDef | ast.AsyncFunctionDef, qual: str) -> FunctionInfo:
    args = node.args
    params = len(args.posonlyargs) + len(args.args) + len(args.kwonlyargs)
    if args.args and args.args[0].arg in ("self", "cls"):
        params -= 1
    exact, loose, shape = _body_hashes(node)
    return FunctionInfo(
        name=node.name,
        qualname=qual,
        line=node.lineno,
        end_line=getattr(node, "end_lineno", node.lineno) or node.lineno,
        params=params,
        nesting=nesting_depth(node.body),
        statements=count_statements(node.body),
        is_async=isinstance(node, ast.AsyncFunctionDef),
        decorators=[decorator_name(d) for d in node.decorator_list],
        body_hash=exact,
        loose_hash=loose,
        shape_hash=shape,
    )


def _annotation_names(node: ast.expr | None) -> list[str]:
    if node is None:
        return []
    names = []
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name):
            names.append(sub.id)
        elif isinstance(sub, ast.Attribute):
            names.append(sub.attr)
        elif isinstance(sub, ast.Constant) and isinstance(sub.value, str):
            names.extend(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", sub.value))
    return names


def _class_info(node: ast.ClassDef) -> ClassInfo:
    info = ClassInfo(
        name=node.name,
        line=node.lineno,
        end_line=getattr(node, "end_lineno", node.lineno) or node.lineno,
        bases=[ast.unparse(b) for b in node.bases],
        decorators=[decorator_name(d) for d in node.decorator_list],
    )
    info.abstract = any(b.split(".")[-1] in ("ABC", "Protocol") or b.startswith("Protocol[") for b in info.bases)
    for stmt in node.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            info.methods.append(_function_info(stmt, f"{node.name}.{stmt.name}"))
            if any(d.split(".")[-1] == "abstractmethod" for d in info.methods[-1].decorators):
                info.abstract = True
            if stmt.name == "__init__":
                args = (stmt.args.posonlyargs + stmt.args.args)[1:] + stmt.args.kwonlyargs
                info.init_params = {a.arg: ast.unparse(a.annotation) for a in args if a.annotation is not None}
            for sub in ast.walk(stmt):
                if isinstance(sub, ast.AnnAssign) and isinstance(sub.target, ast.Attribute) \
                        and isinstance(sub.target.value, ast.Name) and sub.target.value.id == "self":
                    info.attributes.setdefault(sub.target.attr, ast.unparse(sub.annotation))
                elif isinstance(sub, ast.Assign):
                    for tgt in sub.targets:
                        if isinstance(tgt, ast.Attribute) and isinstance(tgt.value, ast.Name) and tgt.value.id == "self":
                            kind = ""
                            if isinstance(sub.value, ast.Call):
                                kind = decorator_name(sub.value)
                            info.attributes.setdefault(tgt.attr, kind)
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            info.attributes.setdefault(stmt.target.id, ast.unparse(stmt.annotation))
    return info


def _guard_of(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> str | None:
    cur = parents.get(node)
    while cur is not None:
        if isinstance(cur, ast.Try):
            for handler in cur.handlers:
                if handler.type is not None and any(
                        n in ("ImportError", "ModuleNotFoundError") for n in _annotation_names(handler.type)):
                    return "try-except-ImportError"
        if isinstance(cur, ast.If):
            test = ast.unparse(cur.test)
            if "TYPE_CHECKING" in test:
                return "TYPE_CHECKING"
        if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return "function-local"
        cur = parents.get(cur)
    return None


def parse_module(root: Path, rel: str) -> Module:
    path = root / rel
    source = path.read_text(encoding="utf-8", errors="replace")
    lines = source.splitlines()
    code_lines = sum(1 for ln in lines if ln.strip() and not ln.strip().startswith("#"))
    mod = Module(
        name=module_name(rel), path=rel, lines=len(lines), code_lines=code_lines,
        is_package_init=Path(rel).name == "__init__.py", is_test=bool(TEST_PATTERN.search(rel)),
        has_main_guard=False, tree=None, source=source,
    )
    try:
        tree = ast.parse(source, filename=rel)
    except SyntaxError as exc:
        mod.syntax_error = f"{exc.msg} (line {exc.lineno})"
        return mod
    mod.tree = tree
    parents: dict[ast.AST, ast.AST] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                mod.imports.append(ImportRef(
                    line=node.lineno, target=alias.name, names=[],
                    alias_map={alias.asname or alias.name.split(".")[0]: alias.name},
                    is_from=False, level=0, guarded=_guard_of(node, parents)))
        elif isinstance(node, ast.ImportFrom):
            names = [a.name for a in node.names if a.name != "*"]
            mod.imports.append(ImportRef(
                line=node.lineno, target=node.module or "", names=names,
                alias_map={(a.asname or a.name): a.name for a in node.names},
                is_from=True, level=node.level or 0, guarded=_guard_of(node, parents)))
    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            mod.functions.append(_function_info(stmt, stmt.name))
            mod.top_names.add(stmt.name)
        elif isinstance(stmt, ast.ClassDef):
            mod.classes.append(_class_info(stmt))
            mod.top_names.add(stmt.name)
        elif isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            for tgt in targets:
                if isinstance(tgt, ast.Name):
                    mod.top_names.add(tgt.id)
                    if tgt.id == "__all__" and isinstance(stmt.value, (ast.List, ast.Tuple)):
                        mod.all_names = [e.value for e in stmt.value.elts
                                         if isinstance(e, ast.Constant) and isinstance(e.value, str)]
        elif hasattr(ast, "TypeAlias") and isinstance(stmt, ast.TypeAlias):
            mod.top_names.add(stmt.name.id)
        elif isinstance(stmt, ast.If) and "__name__" in ast.unparse(stmt.test) and "__main__" in ast.unparse(stmt.test):
            mod.has_main_guard = True
        elif isinstance(stmt, (ast.If, ast.Try)):
            for sub in ast.walk(stmt):
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    mod.top_names.add(sub.name)
                elif isinstance(sub, (ast.Import, ast.ImportFrom)):
                    for alias in sub.names:
                        mod.top_names.add(alias.asname or alias.name.split(".")[0])
                elif isinstance(sub, ast.Assign):
                    mod.top_names.update(t.id for t in sub.targets if isinstance(t, ast.Name))
        elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
            for alias in stmt.names:
                mod.top_names.add(alias.asname or alias.name.split(".")[0])
    return mod


def _frontend_file(root: Path, rel: str) -> FrontendFile:
    text = (root / rel).read_text(encoding="utf-8", errors="replace")
    imports = re.findall(r"""(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]""", text)
    imports += re.findall(r"""<script[^>]*\ssrc=['"]([^'"]+)['"]""", text)
    inline = 0
    for block in re.findall(r"<script(?![^>]*\ssrc=)[^>]*>(.*?)</script>", text, flags=re.S | re.I):
        inline += block.count("\n")
    return FrontendFile(path=rel, lines=text.count("\n") + 1, imports=imports, inline_script_lines=inline)


def build_index(root: Path, include: list[str] | None = None) -> RepoIndex:
    root = root.resolve()
    files = list_files(root)
    if include:
        prefixes = [p.rstrip("/") for p in include]
        files = [f for f in files if any(f == p or f.startswith(p + "/") for p in prefixes)]
    modules: dict[str, Module] = {}
    by_path: dict[str, Module] = {}
    frontend: list[FrontendFile] = []
    other: list[str] = []
    for rel in files:
        full = root / rel
        try:
            size = full.stat().st_size
        except OSError:
            continue
        suffix = full.suffix.lower()
        if suffix == ".py" and size <= MAX_SOURCE_BYTES:
            mod = parse_module(root, rel)
            if mod.name in modules:
                mod.name = rel[:-3].replace("/", ".")
            modules[mod.name] = mod
            by_path[rel] = mod
        elif suffix in FRONTEND_EXT and size <= MAX_SOURCE_BYTES and not rel.endswith(".min.js"):
            frontend.append(_frontend_file(root, rel))
        else:
            other.append(rel)
    src_tops = {m.name.split(".")[0] for m in modules.values() if m.path.startswith("src/") and m.name != "__root__"}
    src_prefixed = False
    if src_tops:
        with_src = without_src = 0
        for mod in modules.values():
            for ref in mod.imports:
                first = ref.target.split(".")[0] if not ref.level else ""
                with_src += first == "src"
                without_src += first in src_tops
        src_prefixed = with_src > without_src
    if src_prefixed:
        for mod in by_path.values():
            if mod.path == "src/__init__.py":
                mod.name = "src"
            elif mod.path.startswith("src/") and not mod.name.startswith("src."):
                mod.name = f"src.{mod.name}"
        modules = {mod.name: mod for mod in by_path.values() if mod.path.endswith(".py")}
    tops = {name.split(".")[0] for name in modules}
    return RepoIndex(root=root, modules=modules, by_path=by_path, frontend=frontend,
                     other_files=other, internal_tops=tops, src_prefixed=src_prefixed, src_tops=src_tops)


def comment_tokens(source: str) -> list[tuple[int, str]]:
    """Return (line, text) for every real comment, skipping '#' inside strings."""
    import io
    import tokenize
    result = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.COMMENT:
                result.append((tok.start[0], tok.string))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        pass
    return result
