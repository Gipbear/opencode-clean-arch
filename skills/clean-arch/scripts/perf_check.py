#!/usr/bin/env python3
"""Performance helpers for the perf-tune skill. Standard library only; never imports the project.

Commands:
  scan     Static candidates: known slow patterns (per-item Transformer/Point creation, iterrows,
           np.add.at, array growth in loops, GPU syncs in loops, ...). Matches are not measurements.
  env      Versions and backends of the performance-relevant libraries in a Python environment
           (protobuf backend, LAZ decoder, thread settings, ...). Use --python for the project's venv.
  bench    Run a shell command repeatedly, report median and spread, save the result under
           .clean-arch/perf/, and compare with a saved baseline (--compare).
  lessons  Search the persistent store of measured optimization lessons, or add one (--entry).

Usage:
  perf_check.py --root . scan [--include PATH ...] [--include-tests] [--limit N] [--format md|json]
  perf_check.py --root . env [--python EXE] [--format md|json]
  perf_check.py --root . bench NAME --cmd "python -m pkg.job" [--runs 7] [--warmup 1] [--compare BASE]
  perf_check.py --root . lessons [--query "shapely contains"] [--entry "## title\\n- status: verified ..."]

A benchmarked command may print lines "PERF_METRIC name=value" (lower is better) to report
in-process measurements next to the wall time of the whole command.

The lessons file is CLEAN_ARCH_LESSONS or ~/.clean-arch/perf-lessons.md.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import statistics
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pyindex import list_files  # noqa: E402

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}
REFS = "skills/perf-tune/references/libraries.md"

# --------------------------------------------------------------------------- scan

PREDICATES = {"contains", "within", "intersects", "covers", "covered_by", "touches", "crosses", "overlaps",
              "disjoint", "distance", "intersection", "difference"}
PROJ_CREATE = {
    "pyproj.Transformer.from_crs", "pyproj.Transformer.from_proj", "pyproj.Transformer.from_pipeline",
    "pyproj.CRS", "pyproj.CRS.from_user_input", "pyproj.CRS.from_epsg", "pyproj.CRS.from_string",
    "pyproj.CRS.from_wkt", "pyproj.CRS.from_proj4", "pyproj.CRS.from_dict", "pyproj.Proj",
}
TREES = {
    "scipy.spatial.cKDTree", "scipy.spatial.KDTree", "scipy.spatial.ckdtree.cKDTree",
    "scipy.spatial.kdtree.KDTree", "sklearn.neighbors.KDTree", "sklearn.neighbors.BallTree",
    "sklearn.neighbors.NearestNeighbors", "shapely.STRtree", "shapely.strtree.STRtree",
}
SKLEARN_TREES = {"sklearn.neighbors.KDTree", "sklearn.neighbors.BallTree", "sklearn.neighbors.NearestNeighbors"}
GROWTH = {"numpy.append", "numpy.concatenate", "numpy.vstack", "numpy.hstack", "numpy.column_stack",
          "numpy.row_stack", "pandas.concat"}
CANON = (("pyproj.crs.crs.", "pyproj."), ("pyproj.crs.", "pyproj."), ("pyproj.transformer.", "pyproj."),
         ("pyproj.proj.", "pyproj."), ("shapely.geometry.point.", "shapely.geometry."))
POINTS = {"shapely.geometry.Point", "shapely.Point"}
UFUNC_AT = re.compile(r"^numpy\.\w+\.at$")
ELEMENT_LIBS = {"numpy", "cv2", "torch"}
TEST_PART = re.compile(r"(^|/)(tests?|testing|conftest\.py)(/|$)|(^|/)test_[^/]*\.py$|_test\.py$")

RULES: dict[str, tuple[str, str]] = {
    # rule: (message, hint section in libraries.md)
    "PERF-ITERROWS": ("DataFrame.iterrows builds a Series per row", "NumPy / pandas vectorization"),
    "PERF-APPLY-ROW": ("DataFrame.apply(axis=1) runs Python per row", "NumPy / pandas vectorization"),
    "PERF-PROJ-CREATE-LOOP": ("pyproj Transformer/CRS/Proj created inside a loop", "pyproj"),
    "PERF-PROJ-TRANSFORM-FN": ("pyproj.transform builds a transformer on every call (deprecated)", "pyproj"),
    "PERF-PROJ-SCALAR-LOOP": ("transform call inside a loop; batch the coordinates into arrays", "pyproj"),
    "PERF-SHAPELY-POINT-LOOP": ("Point(...) created per iteration", "Shapely"),
    "PERF-SHAPELY-PREDICATE-LOOP": ("shapely predicate called per geometry in a Python loop", "Shapely"),
    "PERF-SHAPELY-OPS-TRANSFORM": ("shapely.ops.transform calls the function per geometry (deprecated)", "Shapely"),
    "PERF-SHAPELY-UNION-LOOP": ("pairwise union in a loop; use shapely.union_all", "Shapely"),
    "PERF-TREE-IN-LOOP": ("spatial index / KD-tree built inside a loop", "scikit-learn / Shapely"),
    "PERF-SKLEARN-KNN": ("sklearn tree queries are single-threaded; compare scipy cKDTree(workers=-1)", "scikit-learn"),
    "PERF-NP-ADD-AT": ("ufunc.at is slow on large arrays; use bincount / reduceat", "NumPy"),
    "PERF-NP-UNIQUE-AXIS": ("np.unique(axis=...) is slow on large arrays; pack keys then sort", "NumPy"),
    "PERF-CONCAT-LOOP": ("array/DataFrame grown by concatenation inside a loop (quadratic)", "NumPy"),
    "PERF-ELEMENT-LOOP": ("array indexed element by element in a Python loop", "NumPy"),
    "PERF-TORCH-SYNC-LOOP": ("tensor .item()/.cpu()/.numpy() inside a loop forces a device sync", "PyTorch"),
    "PERF-TORCH-CDIST": ("torch.cdist builds an N x M matrix; chunk large inputs", "PyTorch"),
    "PERF-LAS-READ-ALL": ("laspy.read loads every point and dimension", "laspy"),
    "PERF-LAS-XYZ": ("las.xyz allocates a new (N, 3) array", "laspy"),
    "PERF-PB-REFLECTION": ("protobuf reflection (ListFields / MessageToDict) in a loop", "protobuf"),
    "PERF-POT-EMD": ("exact OT needs an n x m cost matrix and O(n^3) time; check problem size", "POT"),
    "PERF-LIST-FRONT": ("pop(0)/insert(0, ...) in a loop is quadratic on a list; use collections.deque", "techniques.md rung 2"),
    "PERF-DEEPCOPY-LOOP": ("copy.deepcopy inside a loop", "techniques.md rung 1"),
    "PERF-STR-CONCAT-LOOP": ("string built with += in a loop; collect parts and join", "techniques.md rung 2"),
    "PERF-CV2-THREADS": ("cv2 used with multiprocessing/DataLoader but cv2.setNumThreads is never called", "OpenCV"),
}
BASE_SEVERITY = {
    "PERF-ITERROWS": "medium", "PERF-APPLY-ROW": "medium", "PERF-PROJ-CREATE-LOOP": "high",
    "PERF-PROJ-TRANSFORM-FN": "medium", "PERF-PROJ-SCALAR-LOOP": "low", "PERF-SHAPELY-POINT-LOOP": "medium",
    "PERF-SHAPELY-PREDICATE-LOOP": "medium", "PERF-SHAPELY-OPS-TRANSFORM": "medium",
    "PERF-SHAPELY-UNION-LOOP": "medium", "PERF-TREE-IN-LOOP": "high", "PERF-SKLEARN-KNN": "low",
    "PERF-NP-ADD-AT": "medium", "PERF-NP-UNIQUE-AXIS": "medium", "PERF-CONCAT-LOOP": "medium",
    "PERF-ELEMENT-LOOP": "medium", "PERF-TORCH-SYNC-LOOP": "medium", "PERF-TORCH-CDIST": "low",
    "PERF-LAS-READ-ALL": "low", "PERF-LAS-XYZ": "low", "PERF-PB-REFLECTION": "medium", "PERF-POT-EMD": "low",
    "PERF-LIST-FRONT": "low", "PERF-DEEPCOPY-LOOP": "medium", "PERF-STR-CONCAT-LOOP": "low",
    "PERF-CV2-THREADS": "low",
}


@dataclass
class Finding:
    rule: str
    severity: str
    path: str
    line: int
    message: str
    hint: str
    in_loop: bool = False


def _canon(name: str | None) -> str | None:
    if not name:
        return name
    for old, new in CANON:
        if name.startswith(old):
            name = new + name[len(old):]
    return name


class Scanner(ast.NodeVisitor):
    def __init__(self, rel: str, tree: ast.AST):
        self.rel = rel
        self.findings: list[Finding] = []
        self.aliases: dict[str, str] = {}
        self.modules: set[str] = set()
        self.loop_depth = 0
        self.loop_vars: list[set[str]] = []
        self._seen: set[tuple[str, int]] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for a in node.names:
                    self.modules.add(a.name)
                    self.aliases[a.asname or a.name.split(".")[0]] = a.name if a.asname else a.name.split(".")[0]
            elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
                self.modules.add(node.module)
                for a in node.names:
                    self.aliases[a.asname or a.name] = f"{node.module}.{a.name}"
        self.tops = {m.split(".")[0] for m in self.modules}

    # -- helpers
    def fq(self, node: ast.AST) -> str | None:
        parts: list[str] = []
        while isinstance(node, ast.Attribute):
            parts.append(node.attr)
            node = node.value
        if not isinstance(node, ast.Name):
            return None
        parts.append(self.aliases.get(node.id, node.id))
        return _canon(".".join(reversed(parts)))

    def has(self, prefix: str) -> bool:
        return any(m == prefix or m.startswith(prefix + ".") for m in self.modules)

    def add(self, rule: str, node: ast.AST, severity: str | None = None) -> None:
        line = getattr(node, "lineno", 0)
        if (rule, line) in self._seen:
            return
        self._seen.add((rule, line))
        severity = severity or BASE_SEVERITY[rule]
        if self.loop_depth >= 2 and severity == "medium":
            severity = "high"
        message, hint = RULES[rule]
        self.findings.append(Finding(rule, severity, self.rel, line, message, hint, self.loop_depth > 0))

    def in_loop(self) -> bool:
        return self.loop_depth > 0

    def current_loop_vars(self) -> set[str]:
        return set().union(*self.loop_vars) if self.loop_vars else set()

    @staticmethod
    def _targets(node: ast.AST) -> set[str]:
        return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}

    # -- scopes and loops
    def _function(self, node: ast.AST) -> None:
        saved = (self.loop_depth, self.loop_vars)
        self.loop_depth, self.loop_vars = 0, []
        self.generic_visit(node)
        self.loop_depth, self.loop_vars = saved

    visit_FunctionDef = visit_AsyncFunctionDef = visit_Lambda = _function

    def _for(self, node: ast.For | ast.AsyncFor) -> None:
        self.visit(node.iter)
        self.loop_depth += 1
        self.loop_vars.append(self._targets(node.target))
        for child in node.body + node.orelse:
            self.visit(child)
        self.loop_vars.pop()
        self.loop_depth -= 1

    visit_For = visit_AsyncFor = _for

    def visit_While(self, node: ast.While) -> None:
        self.loop_depth += 1
        self.loop_vars.append(set())
        self.generic_visit(node)
        self.loop_vars.pop()
        self.loop_depth -= 1

    def _comprehension(self, node: ast.AST) -> None:
        generators = node.generators  # type: ignore[attr-defined]
        self.visit(generators[0].iter)
        self.loop_depth += 1
        self.loop_vars.append(set().union(*(self._targets(g.target) for g in generators)))
        for i, gen in enumerate(generators):
            if i:
                self.visit(gen.iter)
            for cond in gen.ifs:
                self.visit(cond)
        for part in ("elt", "key", "value"):
            if hasattr(node, part):
                self.visit(getattr(node, part))
        self.loop_vars.pop()
        self.loop_depth -= 1

    visit_ListComp = visit_SetComp = visit_DictComp = visit_GeneratorExp = _comprehension

    # -- rules
    def visit_Call(self, node: ast.Call) -> None:
        name = self.fq(node.func)
        attr = node.func.attr if isinstance(node.func, ast.Attribute) else None
        loop = self.in_loop()
        kw = {k.arg: k.value for k in node.keywords if k.arg}

        if attr == "iterrows":
            self.add("PERF-ITERROWS", node)
        if attr == "apply" and isinstance(kw.get("axis"), ast.Constant) and kw["axis"].value in (1, "columns"):
            self.add("PERF-APPLY-ROW", node)

        if loop and name in PROJ_CREATE:
            self.add("PERF-PROJ-CREATE-LOOP", node)
        if name == "pyproj.transform":
            self.add("PERF-PROJ-TRANSFORM-FN", node)
        if loop and attr in {"transform", "transform_point"} and "pyproj" in self.tops and name not in PROJ_CREATE:
            self.add("PERF-PROJ-SCALAR-LOOP", node)

        if loop and name in POINTS:
            self.add("PERF-SHAPELY-POINT-LOOP", node)
        if loop and attr in PREDICATES and "shapely" in self.tops and not self._on_str_accessor(node.func):
            self.add("PERF-SHAPELY-PREDICATE-LOOP", node)
        if name == "shapely.ops.transform":
            self.add("PERF-SHAPELY-OPS-TRANSFORM", node)
        if loop and "shapely" in self.tops and (attr == "union" or (name or "").endswith("unary_union")):
            self.add("PERF-SHAPELY-UNION-LOOP", node)

        if loop and name in TREES:
            self.add("PERF-TREE-IN-LOOP", node)
        if name in SKLEARN_TREES:
            self.add("PERF-SKLEARN-KNN", node)

        if name and UFUNC_AT.match(name):
            self.add("PERF-NP-ADD-AT", node)
        if name == "numpy.unique" and "axis" in kw and not (isinstance(kw["axis"], ast.Constant) and kw["axis"].value is None):
            self.add("PERF-NP-UNIQUE-AXIS", node)
        if loop and name in GROWTH:
            self.add("PERF-CONCAT-LOOP", node)

        if loop and "torch" in self.tops and attr in {"item", "cpu", "numpy", "tolist"} and not node.args:
            self.add("PERF-TORCH-SYNC-LOOP", node)
        if name == "torch.cdist":
            self.add("PERF-TORCH-CDIST", node)

        if name in {"laspy.read", "laspy.read_las"}:
            self.add("PERF-LAS-READ-ALL", node)

        if loop and self.has("google.protobuf") and (
                attr in {"ListFields", "MessageToDict", "MessageToJson", "ParseDict"}
                or (name or "").rsplit(".", 1)[-1] in {"MessageToDict", "MessageToJson", "ParseDict"}):
            self.add("PERF-PB-REFLECTION", node)

        if name in {"ot.emd", "ot.emd2", "ot.lp.emd", "ot.lp.emd2"}:
            self.add("PERF-POT-EMD", node)

        if loop and ((attr == "pop" and len(node.args) == 1 and self._is_zero(node.args[0]))
                     or (attr == "insert" and node.args and self._is_zero(node.args[0]))):
            self.add("PERF-LIST-FRONT", node)
        if loop and name == "copy.deepcopy":
            self.add("PERF-DEEPCOPY-LOOP", node)
        self.generic_visit(node)

    @staticmethod
    def _is_zero(node: ast.AST) -> bool:
        return isinstance(node, ast.Constant) and node.value == 0 and not isinstance(node.value, bool)

    @staticmethod
    def _on_str_accessor(func: ast.AST) -> bool:
        return isinstance(func, ast.Attribute) and isinstance(func.value, ast.Attribute) and func.value.attr == "str"

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr == "xyz" and isinstance(node.ctx, ast.Load) and "laspy" in self.tops:
            self.add("PERF-LAS-XYZ", node)
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        if self.in_loop() and ELEMENT_LIBS & self.tops and isinstance(node.slice, ast.Tuple):
            names = [e.id for e in node.slice.elts if isinstance(e, ast.Name)]
            if sum(1 for n in names if n in self.current_loop_vars()) >= 2:
                self.add("PERF-ELEMENT-LOOP", node)
        self.generic_visit(node)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        value = node.value
        textual = isinstance(value, ast.JoinedStr) or (isinstance(value, ast.Constant) and isinstance(value.value, str)) \
            or (isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "str")
        if self.in_loop() and isinstance(node.op, ast.Add) and textual:
            self.add("PERF-STR-CONCAT-LOOP", node)
        self.generic_visit(node)


def scan_repo(root: Path, include: list[str] | None, include_tests: bool) -> tuple[list[Finding], int, list[str]]:
    findings: list[Finding] = []
    notes: list[str] = []
    scanned = 0
    cv2_file: tuple[str, int] | None = None
    uses_parallel = False
    sets_threads = False
    for rel in list_files(root):
        if not rel.endswith(".py"):
            continue
        if include and not any(rel == p.rstrip("/") or rel.startswith(p.rstrip("/") + "/") for p in include):
            continue
        if not include_tests and TEST_PART.search(rel):
            continue
        try:
            source = (root / rel).read_text(encoding="utf-8", errors="replace")
            tree = ast.parse(source, filename=rel)
        except (SyntaxError, ValueError, OSError) as exc:
            notes.append(f"skipped {rel}: {type(exc).__name__}")
            continue
        scanned += 1
        scanner = Scanner(rel, tree)
        scanner.visit(tree)
        findings.extend(scanner.findings)
        if "cv2" in scanner.tops and cv2_file is None:
            cv2_file = (rel, 1)
        if re.search(r"\bDataLoader\b|\bmultiprocessing\b|ProcessPoolExecutor|\bPool\(", source):
            uses_parallel = True
        if "setNumThreads" in source:
            sets_threads = True
    if cv2_file and uses_parallel and not sets_threads:
        message, hint = RULES["PERF-CV2-THREADS"]
        findings.append(Finding("PERF-CV2-THREADS", "low", cv2_file[0], cv2_file[1], message, hint))
    findings.sort(key=lambda f: (SEVERITY_ORDER[f.severity], f.rule, f.path, f.line))
    return findings, scanned, notes


def render_scan(findings: list[Finding], scanned: int, notes: list[str], limit: int) -> str:
    out = ["# Performance candidates (static scan)", "",
           "These are pattern matches, not measurements. Confirm each with a profile before changing code; "
           f"a match outside the hot path is not worth fixing. Background: `{REFS}`.", "",
           f"{len(findings)} candidates in {scanned} files scanned."]
    if not findings:
        out += ["", "No known slow patterns found. Profile the workload instead of searching for patterns."]
    by_rule: dict[str, list[Finding]] = {}
    for f in findings:
        by_rule.setdefault(f.rule, []).append(f)
    ordered = sorted(by_rule.items(), key=lambda kv: (min(SEVERITY_ORDER[f.severity] for f in kv[1]), -len(kv[1]), kv[0]))
    for rule, items in ordered:
        top = min(items, key=lambda f: SEVERITY_ORDER[f.severity]).severity
        hint = items[0].hint
        ref = f"skills/perf-tune/references/{hint}" if hint.startswith("techniques.md") else f"{REFS} ({hint})"
        out += ["", f"## {rule} [{top}] - {len(items)} match(es)", f"{items[0].message}. See {ref}."]
        for f in items[:limit]:
            out.append(f"- `{f.path}:{f.line}`" + (" (inside a loop)" if f.in_loop else ""))
        if len(items) > limit:
            out.append(f"- ... and {len(items) - limit} more (use --limit or --format json)")
    if notes:
        out += ["", "Notes: " + "; ".join(notes[:5])]
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- env

PROBE = r'''
import json, os, platform, sys
from importlib import metadata
out = {"python": sys.version.split()[0], "platform": platform.platform(), "cpu_count": os.cpu_count(),
       "env": {k: os.environ.get(k) for k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
               "NUMEXPR_NUM_THREADS", "PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "PROJ_NETWORK")},
       "packages": {}, "checks": {}}
DISTS = ["numpy", "scipy", "pandas", "polars", "torch", "torchvision", "shapely", "pyproj", "scikit-learn",
         "laspy", "lazrs", "laszip", "opencv-python", "opencv-python-headless", "opencv-contrib-python",
         "opencv-contrib-python-headless", "protobuf", "POT", "joblib", "threadpoolctl", "numba", "orjson",
         "uvloop", "geopandas", "rasterio", "open3d", "faiss-cpu", "faiss-gpu", "pykeops", "geomloss"]
for name in DISTS:
    try:
        out["packages"][name] = metadata.version(name)
    except metadata.PackageNotFoundError:
        pass
P = out["packages"]
def check(key, fn):
    try:
        out["checks"][key] = fn()
    except Exception as exc:
        out["checks"][key] = {"error": type(exc).__name__ + ": " + str(exc)[:200]}
if "protobuf" in P:
    def _pb():
        from google.protobuf.internal import api_implementation
        return api_implementation.Type()
    check("protobuf_backend", _pb)
if "laspy" in P:
    def _laz():
        from laspy.compression import LazBackend
        return [b.name for b in LazBackend.detect_available()]
    check("laz_backends", _laz)
if "shapely" in P:
    def _shp():
        import shapely
        return {"geos": ".".join(map(str, getattr(shapely, "geos_version", ())))}
    check("shapely", _shp)
if "pyproj" in P:
    def _proj():
        import pyproj
        from pyproj import network
        return {"proj": pyproj.proj_version_str, "network": bool(network.is_network_enabled())}
    check("pyproj", _proj)
if any(k.startswith("opencv") for k in P):
    def _cv():
        import cv2
        return {"threads": cv2.getNumThreads(), "optimized": cv2.useOptimized(), "opencl": bool(cv2.ocl.haveOpenCL())}
    check("opencv", _cv)
if "torch" in P:
    def _torch():
        import torch
        return {"threads": torch.get_num_threads(), "cuda": bool(torch.cuda.is_available()),
                "devices": torch.cuda.device_count(), "cuda_version": torch.version.cuda}
    check("torch", _torch)
if "threadpoolctl" in P:
    def _tp():
        import numpy  # load the BLAS that numpy uses
        try:
            import scipy, sklearn  # noqa
        except Exception:
            pass
        from threadpoolctl import threadpool_info
        return [{"api": d.get("user_api"), "lib": d.get("internal_api"), "threads": d.get("num_threads"),
                 "file": os.path.basename(d.get("filepath") or "")} for d in threadpool_info()]
    check("threadpools", _tp)
print(json.dumps(out))
'''

OPENCV_DISTS = ("opencv-python", "opencv-python-headless", "opencv-contrib-python", "opencv-contrib-python-headless")


def probe_env(python: str) -> dict:
    result = subprocess.run([python, "-c", PROBE], capture_output=True, text=True, timeout=180,
                            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"})
    if result.returncode != 0:
        sys.exit(f"probe failed with {python!r} (exit {result.returncode}): {result.stderr.strip()[-500:]}")
    return json.loads(result.stdout.strip().splitlines()[-1])


def _major_minor(version: str) -> tuple[int, int]:
    nums = re.findall(r"\d+", version)[:2]
    return (int(nums[0]), int(nums[1]) if len(nums) > 1 else 0) if nums else (0, 0)


def env_findings(data: dict) -> list[tuple[str, str]]:
    """Return (level, text) where level is warn or info."""
    pk, checks, env = data["packages"], data["checks"], data["env"]
    found: list[tuple[str, str]] = []
    if _major_minor(data["python"]) < (3, 11):
        found.append(("info", f"Python {data['python']}: 3.11 and later are substantially faster on interpreter-bound code."))
    if "shapely" in pk and _major_minor(pk["shapely"])[0] < 2:
        found.append(("warn", f"Shapely {pk['shapely']} has no vectorized API (2.0+); per-geometry Python loops are the only option."))
    backend = checks.get("protobuf_backend")
    if backend == "python" or env.get("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION") == "python":
        found.append(("warn", "protobuf uses the pure-Python backend (orders of magnitude slower). Unset "
                              "PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION and use a protobuf wheel with the native upb backend."))
    laz = checks.get("laz_backends")
    if isinstance(laz, list):
        if not laz:
            found.append(("warn", "laspy has no LAZ backend: install lazrs (fast, multi-threaded) to read .laz files."))
        elif not any(b.startswith("Lazrs") for b in laz):
            found.append(("warn", "laspy only has LASzip (single-threaded) for LAZ; install lazrs for multi-threaded decoding."))
    if sum(1 for d in OPENCV_DISTS if d in pk) > 1:
        found.append(("warn", "Several OpenCV distributions are installed (" + ", ".join(d for d in OPENCV_DISTS if d in pk) +
                              "); they overwrite each other's cv2 module. Keep one."))
    pools = checks.get("threadpools")
    if isinstance(pools, list):
        openmp = sorted({p["lib"] for p in pools if p.get("api") == "openmp" and p.get("lib")})
        if len(openmp) > 1:
            found.append(("warn", "More than one OpenMP runtime is loaded (" + ", ".join(openmp) + "); this causes oversubscription "
                                  "and slowdowns. Align the wheels or set OMP_NUM_THREADS."))
    if not any(env.get(k) for k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS")):
        found.append(("info", f"No thread-count environment variables are set: BLAS/OpenMP use all {data['cpu_count']} cores. "
                              "Set them to 1 inside worker pools, or use threadpoolctl."))
    if isinstance(checks.get("torch"), dict) and checks["torch"].get("cuda") is False:
        found.append(("info", "torch is installed but CUDA is not available in this environment."))
    if isinstance(checks.get("pyproj"), dict) and checks["pyproj"].get("network"):
        found.append(("info", "PROJ network access is enabled; offline machines may stall on grid downloads (PROJ_NETWORK=OFF)."))
    return found


def render_env(data: dict) -> str:
    out = ["# Performance environment", "", f"- Python {data['python']} on {data['platform']}, {data['cpu_count']} logical CPUs"]
    thread_env = {k: v for k, v in data["env"].items() if v}
    out.append("- Environment: " + (", ".join(f"{k}={v}" for k, v in thread_env.items()) if thread_env else "no thread or backend variables set"))
    out += ["", "| Package | Version |", "|---|---|"]
    out += [f"| {name} | {version} |" for name, version in data["packages"].items()]
    if not data["packages"]:
        out.append("| (none of the tracked packages installed) | |")
    if data["checks"]:
        out += ["", "Runtime checks:"]
        for key, value in data["checks"].items():
            out.append(f"- {key}: {json.dumps(value, ensure_ascii=False)}")
    findings = env_findings(data)
    out += ["", "## Findings"]
    out += [f"- {'WARNING' if level == 'warn' else 'note'}: {text}" for level, text in findings] or ["- Nothing unusual."]
    out += ["", f"Background: `{REFS}`."]
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- bench

METRIC = re.compile(r"^PERF_METRIC\s+([A-Za-z_][\w.\-]*)\s*=\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$", re.M)


def stats(values: list[float]) -> dict:
    ordered = sorted(values)
    median = statistics.median(ordered)
    if len(ordered) >= 5:
        q = statistics.quantiles(ordered, n=4, method="inclusive")
        spread = (q[2] - q[0]) / median if median else 0.0
    else:
        spread = (ordered[-1] - ordered[0]) / median if median else 0.0
    return {"n": len(ordered), "min": ordered[0], "median": median, "max": ordered[-1], "spread": spread}


def run_bench(command: str, cwd: Path, runs: int, warmup: int, timeout: float | None) -> dict[str, list[float]]:
    metrics: dict[str, list[float]] = {"wall": []}
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"}
    for i in range(warmup + runs):
        start = time.perf_counter()
        proc = subprocess.run(command, shell=True, cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout, env=env)
        elapsed = time.perf_counter() - start
        if proc.returncode != 0:
            tail = "\n".join((proc.stderr or proc.stdout).strip().splitlines()[-15:])
            sys.exit(f"command failed (exit {proc.returncode}) on run {i + 1}:\n{tail}")
        if i < warmup:
            continue
        metrics["wall"].append(elapsed)
        for name, value in {m[0]: float(m[1]) for m in METRIC.findall(proc.stdout)}.items():
            metrics.setdefault(name, []).append(value)
    return {k: v for k, v in metrics.items() if len(v) == runs}


def fmt_seconds(value: float) -> str:
    if value >= 100:
        return f"{value:.1f}"
    if value >= 1:
        return f"{value:.3f}"
    return f"{value:.4f}"


def render_bench(name: str, command: str, result: dict, baseline: dict | None, threshold: float, base_name: str | None) -> str:
    out = [f"# Benchmark `{name}`", "", f"Command: `{command}`", f"Runs: {result['runs']} (after {result['warmup']} warm-up), "
           "lower is better. Wall time includes interpreter start-up and imports.", "",
           "| Metric | min | median | max | spread |", "|---|---|---|---|---|"]
    computed = {k: stats(v) for k, v in result["metrics"].items()}
    for metric, s in computed.items():
        out.append(f"| {metric} | {fmt_seconds(s['min'])} | {fmt_seconds(s['median'])} | {fmt_seconds(s['max'])} | {s['spread']:.1%} |")
    noisy = [m for m, s in computed.items() if s["spread"] > 0.10]
    if noisy:
        out += ["", f"WARNING: spread above 10% for {', '.join(noisy)}. Reduce noise (other load, input size, GC, caches) "
                    "or add runs before trusting a comparison."]
    if baseline:
        out += ["", f"## Compared with `{base_name}`", ""]
        if baseline.get("command") != command:
            out.append(f"WARNING: the baseline ran a different command: `{baseline.get('command')}`")
        out += ["| Metric | baseline median | new median | change | verdict |", "|---|---|---|---|---|"]
        for metric, new in computed.items():
            if metric not in baseline["metrics"]:
                continue
            old = stats(baseline["metrics"][metric])
            change = (new["median"] - old["median"]) / old["median"] if old["median"] else 0.0
            band = max(threshold, old["spread"], new["spread"])
            verdict = "within noise" if abs(change) <= band else ("faster" if change < 0 else "SLOWER")
            out.append(f"| {metric} | {fmt_seconds(old['median'])} | {fmt_seconds(new['median'])} | {change:+.1%} | {verdict} |")
        out += ["", f"A change counts only when it exceeds max({threshold:.0%}, the larger spread of the two runs)."]
    return "\n".join(out) + "\n"


def cmd_bench(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    if not re.fullmatch(r"[\w.\-]+", args.name):
        sys.exit("benchmark name may only contain letters, digits, '.', '_' and '-'")
    if args.runs < 3:
        sys.exit("--runs must be at least 3 to estimate noise")
    cwd = (root / args.cwd).resolve() if args.cwd else root
    store = root / ".clean-arch" / "perf"
    store.mkdir(parents=True, exist_ok=True)
    baseline = None
    if args.compare:
        base_file = store / f"bench-{args.compare}.json"
        if not base_file.is_file():
            sys.exit(f"no saved benchmark named {args.compare!r} ({base_file.name}); run it first without --compare")
        baseline = json.loads(base_file.read_text(encoding="utf-8"))
    metrics = run_bench(args.cmd, cwd, args.runs, args.warmup, args.timeout)
    result = {"name": args.name, "command": args.cmd, "runs": args.runs, "warmup": args.warmup,
              "created": date.today().isoformat(), "python": sys.version.split()[0], "metrics": metrics}
    (store / f"bench-{args.name}.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    sys.stdout.write(render_bench(args.name, args.cmd, result, baseline, args.threshold, args.compare))
    sys.stdout.write(f"\nSaved to .clean-arch/perf/bench-{args.name}.json\n")
    return 0


# --------------------------------------------------------------------------- lessons

REQUIRED_FIELDS = ("status", "topics", "symptom", "change", "result", "environment")
STATUSES = {"verified", "rejected"}
ABS_PATH = re.compile(r"(?:\b[A-Za-z]:[\\/]|(?:^|\s)/(?:home|Users|mnt|opt|srv|data|workspace)/)")
LESSONS_HEADER = (
    "# Performance lessons\n\n"
    "Measured optimization results collected by the perf-tune skill. Each entry is a verified win or a "
    "rejected attempt, with the workload and versions it was measured on. Treat entries as hypotheses "
    "for new code: measure again before relying on them.\n"
)


def lessons_path() -> Path:
    custom = os.environ.get("CLEAN_ARCH_LESSONS")
    return Path(custom).expanduser() if custom else Path.home() / ".clean-arch" / "perf-lessons.md"


def parse_entries(text: str) -> list[dict]:
    entries: list[dict] = []
    current: dict | None = None
    last_key: str | None = None
    for raw in text.splitlines():
        if raw.startswith("## "):
            current = {"title": raw[3:].strip(), "fields": {}, "raw": [raw]}
            entries.append(current)
            last_key = None
        elif current is not None:
            current["raw"].append(raw)
            field = re.match(r"^- ([A-Za-z_]+):\s*(.*)$", raw)
            if field:
                last_key = field.group(1).lower()
                current["fields"][last_key] = field.group(2).strip()
            elif raw.startswith("  ") and last_key:
                current["fields"][last_key] += " " + raw.strip()
    for entry in entries:
        entry["text"] = "\n".join(entry["raw"]).rstrip()
    return entries


def validate_entry(entry: dict) -> list[str]:
    problems = []
    fields = entry["fields"]
    if not entry["title"]:
        problems.append("empty title")
    for key in REQUIRED_FIELDS:
        if not fields.get(key):
            problems.append(f"missing field '{key}'")
    if fields.get("status") and fields["status"] not in STATUSES:
        problems.append(f"status must be one of {sorted(STATUSES)}")
    if fields.get("status") == "verified" and fields.get("result") and not re.search(r"\d", fields["result"]):
        problems.append("a verified entry needs measured numbers in 'result' (before -> after)")
    if len(entry["text"]) > 1800:
        problems.append("entry is longer than 1800 characters; keep it short")
    if ABS_PATH.search(entry["text"]):
        problems.append("contains an absolute path; remove paths and project-specific names so the lesson is generic")
    return problems


def normalize_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def search_entries(entries: list[dict], query: str, limit: int) -> list[dict]:
    tokens = [t for t in re.split(r"\W+", query.lower()) if t]
    scored = []
    for entry in entries:
        hay = entry["text"].lower()
        hits = sum(1 for t in tokens if t in hay)
        if hits:
            scored.append((hits, entry))
    all_hit = [e for h, e in scored if h == len(tokens)]
    pool = all_hit or [e for _, e in sorted(scored, key=lambda p: -p[0])]
    return pool[:limit]


def cmd_lessons(args: argparse.Namespace) -> int:
    path = lessons_path()
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    entries = parse_entries(text)
    if args.entry:
        new_text = args.entry.replace("\\n", "\n").strip()
        parsed = parse_entries(new_text)
        if len(parsed) != 1 or not new_text.startswith("## "):
            sys.exit("--entry must be exactly one entry: a '## title' line followed by '- key: value' lines")
        entry = parsed[0]
        if "date" not in entry["fields"]:
            entry["fields"]["date"] = date.today().isoformat()
            entry["text"] += f"\n- date: {entry['fields']['date']}"
        problems = validate_entry(entry)
        if problems:
            sys.exit("entry rejected:\n- " + "\n- ".join(problems))
        same = [e for e in entries if normalize_title(e["title"]) == normalize_title(entry["title"])]
        if same:
            sys.exit(f"an entry with this title already exists in {path}; edit that entry instead of adding a duplicate:\n{same[0]['text']}")
        path.parent.mkdir(parents=True, exist_ok=True)
        base = text.rstrip() + "\n" if text.strip() else LESSONS_HEADER
        path.write_text(base + "\n" + entry["text"] + "\n", encoding="utf-8")
        print(f"Added lesson: {entry['title']}\nStore: {path} ({len(entries) + 1} entries)")
        return 0
    out = [f"# Performance lessons", "", f"Store: `{path}` ({len(entries)} entries)"]
    if not path.is_file():
        out += ["", "No lessons recorded yet. After a measured, verified result, add one with --entry "
                    "(see the entry format in the perf-tune skill)."]
    bad = [(e["title"], validate_entry(e)) for e in entries]
    bad = [(t, p) for t, p in bad if p]
    if args.query:
        hits = search_entries(entries, args.query, args.limit)
        out += ["", f"## Entries matching \"{args.query}\" ({len(hits)})", ""]
        out += [e["text"] + "\n" for e in hits] or ["No match. Nothing recorded for this topic yet."]
    elif entries:
        out += ["", "## Index", ""]
        for e in entries:
            f = e["fields"]
            out.append(f"- {e['title']} [{f.get('status', '?')}; {f.get('topics', '')}]")
    if bad:
        out += ["", "Entries with format problems:"]
        out += [f"- {title}: {'; '.join(problems)}" for title, problems in bad]
    print("\n".join(out))
    return 0


# --------------------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=".")
    sub = parser.add_subparsers(dest="command", required=True)

    scan = sub.add_parser("scan", help="static scan for known slow patterns")
    scan.add_argument("--include", action="append", help="only scan these paths (repeatable)")
    scan.add_argument("--include-tests", action="store_true")
    scan.add_argument("--limit", type=int, default=8, help="locations shown per rule")
    scan.add_argument("--format", choices=["md", "json"], default="md")

    env = sub.add_parser("env", help="versions and backends of performance-relevant libraries")
    env.add_argument("--python", default=sys.executable, help="interpreter of the project environment")
    env.add_argument("--format", choices=["md", "json"], default="md")

    bench = sub.add_parser("bench", help="repeat a command, report median and spread, compare with a baseline")
    bench.add_argument("name")
    bench.add_argument("--cmd", required=True, help="shell command to time")
    bench.add_argument("--runs", type=int, default=7)
    bench.add_argument("--warmup", type=int, default=1)
    bench.add_argument("--cwd", help="working directory relative to the root")
    bench.add_argument("--compare", help="name of a saved benchmark to compare with")
    bench.add_argument("--threshold", type=float, default=0.05, help="minimum relative change that counts (default 0.05)")
    bench.add_argument("--timeout", type=float, default=1800, help="seconds per run")

    lessons = sub.add_parser("lessons", help="search or add measured optimization lessons")
    lessons.add_argument("--query")
    lessons.add_argument("--entry", help="one Markdown entry to add (use \\n for line breaks)")
    lessons.add_argument("--limit", type=int, default=8)

    args = parser.parse_args(argv)
    if args.command == "scan":
        root = Path(args.root).resolve()
        findings, scanned, notes = scan_repo(root, args.include, args.include_tests)
        if args.format == "json":
            print(json.dumps([asdict(f) for f in findings], indent=1))
        else:
            sys.stdout.write(render_scan(findings, scanned, notes, args.limit))
        return 0
    if args.command == "env":
        data = probe_env(args.python)
        if args.format == "json":
            data["findings"] = [{"level": level, "text": text} for level, text in env_findings(data)]
            print(json.dumps(data, indent=1))
        else:
            sys.stdout.write(render_env(data))
        return 0
    if args.command == "bench":
        return cmd_bench(args)
    return cmd_lessons(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.TimeoutExpired as exc:
        sys.exit(f"timed out after {exc.timeout:.0f}s: {exc.cmd}")
