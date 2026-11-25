"""Profiling runners, cross-platform peak RSS measurement, and self-contained SVG charts.

Used by perf_check.py. Standard library only; invokes external open-source profilers
(py-spy, pyinstrument, memray) automatically when present in the target environment and
falls back cleanly to cProfile, tracemalloc, -X importtime and OS process memory counters.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from dataclasses import dataclass, field
from html import escape
from pathlib import Path


@dataclass
class RunSample:
    returncode: int
    elapsed: float
    peak_mb: float | None
    stdout: str
    stderr: str


@dataclass
class FlameNode:
    name: str
    value: float
    self_value: float = 0.0
    category: str = "app"  # "app" | "lib" | "native"
    detail: str = ""
    children: list["FlameNode"] = field(default_factory=list)


# --------------------------------------------------------- cross-platform Peak RSS runner

_POSIX_WRAPPER = r"""
import json, os, resource, subprocess, sys, time
cmd, cwd = sys.argv[1], sys.argv[2]
t0 = time.perf_counter()
proc = subprocess.run(cmd, shell=True, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
elapsed = time.perf_counter() - t0
ru = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
divisor = 1048576.0 if sys.platform == "darwin" else 1024.0
peak_mb = round(ru / divisor, 2) if ru > 0 else None
sys.stdout.buffer.write(proc.stdout)
sys.stderr.buffer.write(proc.stderr)
meta = {"rc": proc.returncode, "elapsed": elapsed, "peak_mb": peak_mb}
sys.stderr.buffer.write(b"\n__CLEAN_ARCH_RUN_META__=" + json.dumps(meta).encode("utf-8") + b"\n")
sys.exit(proc.returncode)
"""


def _win32_run_with_peak_mb(command: str, cwd: Path, env: dict[str, str], timeout: float | None) -> RunSample:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]

    class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
        )]

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    job = kernel32.CreateJobObjectW(None, None)
    assigned = False
    start = time.perf_counter()
    proc = subprocess.Popen(command, shell=True, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    try:
        handle = wintypes.HANDLE(int(proc._handle))  # type: ignore[attr-defined]
        if job:
            assigned = bool(kernel32.AssignProcessToJobObject(job, handle))
        try:
            out_b, err_b = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            raise
        elapsed = time.perf_counter() - start
        peak_bytes = 0
        pmc = PROCESS_MEMORY_COUNTERS()
        pmc.cb = ctypes.sizeof(pmc)
        if kernel32.K32GetProcessMemoryInfo(handle, ctypes.byref(pmc), pmc.cb):
            peak_bytes = max(peak_bytes, int(pmc.PeakWorkingSetSize), int(pmc.PeakPagefileUsage))
        if job and assigned:
            jeli = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            ret_len = wintypes.DWORD(0)
            if kernel32.QueryInformationJobObject(job, 9, ctypes.byref(jeli), ctypes.sizeof(jeli), ctypes.byref(ret_len)):
                peak_bytes = max(peak_bytes, int(jeli.PeakJobMemoryUsed), int(jeli.PeakProcessMemoryUsed))
        peak_mb = round(peak_bytes / 1048576.0, 2) if peak_bytes > 0 else None
        return RunSample(
            returncode=proc.returncode or 0,
            elapsed=elapsed,
            peak_mb=peak_mb,
            stdout=out_b.decode("utf-8", errors="replace"),
            stderr=err_b.decode("utf-8", errors="replace"),
        )
    finally:
        if job:
            kernel32.CloseHandle(job)


def run_measured_command(command: str, cwd: Path, timeout: float | None = None) -> RunSample:
    """Run a shell command, returning wall time and cross-platform Peak RSS/commit in MB."""
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    if os.name == "nt":
        return _win32_run_with_peak_mb(command, cwd, env, timeout)
    proc = subprocess.run(
        [sys.executable, "-c", _POSIX_WRAPPER, command, str(cwd)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, env=env,
    )
    stderr = proc.stderr
    elapsed = 0.0
    peak_mb: float | None = None
    marker = "__CLEAN_ARCH_RUN_META__="
    if marker in stderr:
        clean_lines = []
        for ln in stderr.splitlines():
            if ln.startswith(marker):
                try:
                    meta = json.loads(ln[len(marker):])
                    elapsed = float(meta.get("elapsed", 0.0))
                    peak_mb = meta.get("peak_mb")
                except Exception:
                    pass
            else:
                clean_lines.append(ln)
        stderr = "\n".join(clean_lines)
    return RunSample(returncode=proc.returncode, elapsed=elapsed, peak_mb=peak_mb, stdout=proc.stdout, stderr=stderr)


# --------------------------------------------------------- self-contained SVG renderers

PALETTE = {
    "app": ("#E76F51", "#F4845F"),
    "lib": ("#457B9D", "#5C8EAD"),
    "native": ("#2A9D8F", "#3AB0A2"),
    "other": ("#8D99AE", "#9EA9BC"),
}


def infer_metric_unit(metric: str) -> tuple[str, str]:
    """Return (unit_suffix, kind_label) where kind_label is 'time' | 'memory' | 'count'."""
    m = metric.lower()
    if m == "peak_mb" or m.endswith("_mb"):
        return "MB", "memory"
    if m.endswith("_ms"):
        return "ms", "time"
    if m in ("count", "lines", "items", "rows", "calls") or m.endswith(
        ("_count", "_lines", "_items", "_rows", "_calls", "_blocks", "_ops", "_files", "_records")
    ):
        return "", "count"
    if m == "wall" or m.endswith(("_s", "_sec", "_secs", "_seconds", "_time")) or m in ("cpu", "elapsed", "latency", "duration"):
        return "s", "time"
    return "", "time"


def _fmt_val(v: float, unit: str) -> str:
    if unit == "s":
        if v >= 10:
            return f"{v:.2f}s"
        if v >= 0.1:
            return f"{v:.3f}s"
        return f"{v * 1000:.1f}ms"
    if unit == "MB":
        return f"{v:.1f} MB" if v >= 10 else f"{v:.2f} MB"
    if unit == "ms":
        return f"{v:.1f} ms" if v >= 10 else f"{v:.2f} ms"
    if not unit:
        if abs(v - round(v)) < 1e-9 and abs(v) < 1e15:
            return f"{int(round(v))}"
        return f"{v:.4g}"
    return f"{v:.3g} {unit}".strip()


def _truncate(text: str, px_width: float, char_px: float = 6.6) -> str:
    budget = int((px_width - 10) / char_px)
    if budget <= 3:
        return ""
    if len(text) <= budget:
        return text
    return text[: max(1, budget - 1)] + "…"


def render_flame_svg(root: FlameNode, title: str, subtitle: str, unit: str = "s", max_depth: int = 16) -> str:
    """Render a self-contained icicle flame graph SVG (literal hex colours, no external fonts or JS)."""
    width = 960
    pad_x = 16
    inner_w = width - 2 * pad_x
    header_h = 62
    row_h = 22
    row_gap = 2
    total = max(root.value, 1e-9)

    boxes: list[tuple[int, float, float, FlameNode, bool]] = []

    def layout(node: FlameNode, depth: int, x0: float, w: float) -> None:
        if depth > max_depth or w < 2.0:
            return
        boxes.append((depth, x0, w, node, False))
        if not node.children or depth == max_depth:
            return
        cursor = x0
        tiny_val = 0.0
        tiny_count = 0
        ordered = sorted(node.children, key=lambda c: -c.value)
        for child in ordered:
            cw = inner_w * (child.value / total)
            if cw > x0 + w - cursor:
                cw = max(0.0, x0 + w - cursor)
            if cw < 4.5:
                tiny_val += child.value
                tiny_count += 1
                continue
            layout(child, depth + 1, cursor, cw)
            cursor += cw
        if tiny_val > 0 and tiny_count > 0:
            tw = min(inner_w * (tiny_val / total), max(0.0, x0 + w - cursor))
            if tw >= 4.0:
                merged = FlameNode(
                    name=f"({tiny_count} small frames)",
                    value=tiny_val,
                    category="other",
                    detail=f"{tiny_count} frames below 0.5% threshold",
                )
                boxes.append((depth + 1, cursor, tw, merged, True))

    layout(root, 0, float(pad_x), float(inner_w))
    used_depth = max((d for d, _, _, _, _ in boxes), default=0)
    height = header_h + (used_depth + 1) * (row_h + row_gap) + 18

    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}">',
        f'  <rect x="0" y="0" width="{width}" height="{height}" fill="#FAFBFD" rx="6"/>',
        f'  <rect x="0.5" y="0.5" width="{width - 1}" height="{height - 1}" fill="none" stroke="#E2E8F0" rx="6"/>',
        f'  <text x="{pad_x}" y="26" fill="#1E293B" font-family="system-ui,-apple-system,Segoe UI,sans-serif" '
        f'font-size="15" font-weight="600">{escape(title)}</text>',
        f'  <text x="{pad_x}" y="46" fill="#64748B" font-family="system-ui,-apple-system,Segoe UI,sans-serif" '
        f'font-size="12">{escape(subtitle)}</text>',
    ]
    legend = [("Project code", "#E76F51"), ("Library / stdlib", "#457B9D"), ("C / native", "#2A9D8F")]
    lx = width - pad_x - 330
    for label, color in legend:
        lines.append(f'  <rect x="{lx}" y="15" width="11" height="11" rx="2" fill="{color}"/>')
        lines.append(
            f'  <text x="{lx + 15}" y="25" fill="#475569" font-family="system-ui,-apple-system,Segoe UI,sans-serif" '
            f'font-size="11">{escape(label)}</text>'
        )
        lx += 112

    for depth, x, w, node, is_other in boxes:
        y = header_h + depth * (row_h + row_gap)
        c1, c2 = PALETTE.get(node.category, PALETTE["lib"])
        fill = "#1E293B" if depth == 0 else (c1 if depth % 2 == 1 else c2)
        if is_other:
            fill = PALETTE["other"][0]
        pct = 100.0 * node.value / total
        tip_parts = [node.name, f"{_fmt_val(node.value, unit)} ({pct:.1f}%)"]
        if node.self_value > 0 and depth > 0:
            tip_parts.append(f"self {_fmt_val(node.self_value, unit)}")
        if node.detail:
            tip_parts.append(node.detail)
        tip = " | ".join(tip_parts)
        rw = max(1.0, w - 1.0)
        lines.append("  <g>")
        lines.append(f"    <title>{escape(tip)}</title>")
        lines.append(f'    <rect x="{x:.1f}" y="{y}" width="{rw:.1f}" height="{row_h}" rx="3" fill="{fill}"/>')
        if rw >= 46:
            raw_label = f"{node.name} ({pct:.0f}%)" if rw >= 95 and depth > 0 else node.name
            if depth == 0:
                raw_label = f"{node.name} — {_fmt_val(node.value, unit)} (100%)"
            shown = _truncate(raw_label, rw)
            if shown:
                lines.append(
                    f'    <text x="{x + 5:.1f}" y="{y + 15}" fill="#FFFFFF" '
                    f'font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="11">{escape(shown)}</text>'
                )
        lines.append("  </g>")

    lines.append("</svg>\n")
    return "\n".join(lines)


def render_bench_svg(title: str, comparisons: list[dict], base_name: str, cand_name: str) -> str:
    """Render a self-contained horizontal bar chart comparing baseline vs candidate metrics & memory."""
    width = 860
    pad_x = 18
    header_h = 56
    group_h = 68
    height = header_h + max(1, len(comparisons)) * group_h + 18
    label_w = 155
    bar_x = pad_x + label_w
    bar_max_w = 410
    verdict_x = bar_x + bar_max_w + 18

    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}">',
        f'  <rect x="0" y="0" width="{width}" height="{height}" fill="#FAFBFD" rx="6"/>',
        f'  <rect x="0.5" y="0.5" width="{width - 1}" height="{height - 1}" fill="none" stroke="#E2E8F0" rx="6"/>',
        f'  <text x="{pad_x}" y="26" fill="#1E293B" font-family="system-ui,-apple-system,Segoe UI,sans-serif" '
        f'font-size="15" font-weight="600">{escape(title)}</text>',
        f'  <text x="{pad_x}" y="44" fill="#64748B" font-family="system-ui,-apple-system,Segoe UI,sans-serif" '
        f'font-size="12">Baseline ({escape(base_name)}) vs Candidate ({escape(cand_name)}) — median with min..max whiskers (lower is better)</text>',
    ]

    for idx, row in enumerate(comparisons):
        gy = header_h + idx * group_h
        unit, kind = infer_metric_unit(row["metric"])
        scale_max = max(row["old_max"], row["new_max"], row["old_med"], row["new_med"], 1e-9) * 1.08

        lines.append(f'  <line x1="{pad_x}" y1="{gy}" x2="{width - pad_x}" y2="{gy}" stroke="#EDF2F7"/>')
        lines.append(
            f'  <text x="{pad_x}" y="{gy + 26}" fill="#1E293B" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" '
            f'font-size="12" font-weight="600">{escape(row["metric"])}</text>'
        )
        lines.append(
            f'  <text x="{pad_x}" y="{gy + 44}" fill="#64748B" font-family="system-ui,-apple-system,Segoe UI,sans-serif" '
            f'font-size="11">{escape(kind)}</text>'
        )

        # Baseline bar
        ow = max(2.0, bar_max_w * (row["old_med"] / scale_max))
        ox_min = bar_x + bar_max_w * (row["old_min"] / scale_max)
        ox_max = bar_x + bar_max_w * (row["old_max"] / scale_max)
        lines.append(f'  <rect x="{bar_x}" y="{gy + 11}" width="{ow:.1f}" height="16" rx="3" fill="#64748B"/>')
        lines.append(f'  <line x1="{ox_min:.1f}" y1="{gy + 19}" x2="{ox_max:.1f}" y2="{gy + 19}" stroke="#1E293B" stroke-width="1.5"/>')

        # Candidate bar
        verdict = row["verdict"]
        c_fill = "#2A9D8F" if verdict in ("faster", "lower") else ("#D64545" if verdict in ("SLOWER", "HIGHER") else "#94A3B8")
        nw = max(2.0, bar_max_w * (row["new_med"] / scale_max))
        nx_min = bar_x + bar_max_w * (row["new_min"] / scale_max)
        nx_max = bar_x + bar_max_w * (row["new_max"] / scale_max)
        lines.append(f'  <rect x="{bar_x}" y="{gy + 33}" width="{nw:.1f}" height="16" rx="3" fill="{c_fill}"/>')
        lines.append(f'  <line x1="{nx_min:.1f}" y1="{gy + 41}" x2="{nx_max:.1f}" y2="{gy + 41}" stroke="#1E293B" stroke-width="1.5"/>')

        # Right-hand summary text + badge
        summary = f"{_fmt_val(row['old_med'], unit)} -> {_fmt_val(row['new_med'], unit)} ({row['change']:+.1%})"
        lines.append(
            f'  <text x="{verdict_x}" y="{gy + 24}" fill="#334155" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" '
            f'font-size="12">{escape(summary)}</text>'
        )
        badge_bg = "#E6F4F1" if verdict in ("faster", "lower") else ("#FDECEC" if verdict in ("SLOWER", "HIGHER") else "#F1F5F9")
        badge_fg = "#1D7A6E" if verdict in ("faster", "lower") else ("#B91C1C" if verdict in ("SLOWER", "HIGHER") else "#475569")
        lines.append(f'  <rect x="{verdict_x}" y="{gy + 31}" width="110" height="20" rx="10" fill="{badge_bg}"/>')
        lines.append(
            f'  <text x="{verdict_x + 55}" y="{gy + 45}" text-anchor="middle" fill="{badge_fg}" '
            f'font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="11" font-weight="600">{escape(verdict)}</text>'
        )

    lines.append("</svg>\n")
    return "\n".join(lines)


# --------------------------------------------------------- profiler runners & normalisers

def _classify_path(filepath: str, root: Path) -> str:
    if not filepath or filepath in ("~", "<built-in>") or filepath.startswith("<"):
        return "native"
    try:
        p = Path(filepath)
        full = p.resolve() if p.is_absolute() else (root / p).resolve()
        if full.is_relative_to(root.resolve()) and not any(
            part in {".venv", "venv", "env", "site-packages", "node_modules"} for part in full.parts
        ):
            return "app"
    except OSError:
        pass
    if "site-packages" in filepath or "lib/python" in filepath.replace("\\", "/").lower():
        return "lib"
    return "lib"


def _short_loc(filepath: str, lineno: int, root: Path) -> str:
    if not filepath or filepath in ("~", "<built-in>"):
        return "built-in"
    try:
        p = Path(filepath)
        full = p.resolve() if p.is_absolute() else (root / p).resolve()
        if full.is_relative_to(root.resolve()):
            rel = full.relative_to(root.resolve()).as_posix()
            return f"{rel}:{lineno}" if lineno else rel
    except OSError:
        pass
    tail = "/".join(filepath.replace("\\", "/").split("/")[-2:])
    return f"{tail}:{lineno}" if lineno else tail


def find_tool_near_python(python: str, tool_name: str) -> str | None:
    """Locate a CLI tool (e.g. py-spy) in the target Python's bin/Scripts dir first, then PATH."""
    py_dir = Path(python).resolve().parent
    suffixes = (".exe", "") if os.name == "nt" else ("",)
    for suf in suffixes:
        cand = py_dir / f"{tool_name}{suf}"
        if cand.is_file():
            return str(cand)
    return shutil.which(tool_name)


def python_has_module(python: str, mod_name: str) -> bool:
    proc = subprocess.run(
        [python, "-c", f"import importlib.util, sys; sys.exit(0 if importlib.util.find_spec({mod_name!r}) else 1)"],
        capture_output=True, timeout=15,
    )
    return proc.returncode == 0


def parse_target_args(python: str, target: str | None, cmd: str | None) -> tuple[str, list[str], str]:
    """Resolve (python_exe, py_argv, shell_command) from either --target or --cmd."""
    if target:
        argv = shlex.split(target, posix=(os.name != "nt"))
        if os.name == "nt":
            argv = [a.strip("\"'") for a in argv]
        quoted = " ".join(shlex.quote(x) for x in [python, *argv]) if os.name != "nt" \
            else subprocess.list2cmdline([python, *argv])
        return python, argv, quoted
    if not cmd:
        raise ValueError("profile requires either target (e.g. '-m pkg.job') or command")
    tokens = shlex.split(cmd, posix=(os.name != "nt"))
    if os.name == "nt":
        tokens = [t.strip("\"'") for t in tokens]
    if tokens and re.search(r"python(?:\d+(?:\.\d+)?)?(?:\.exe)?$", tokens[0], re.I):
        exe = tokens[0] if Path(tokens[0]).exists() else (shutil.which(tokens[0]) or python)
        return exe, tokens[1:], cmd
    return python, [], cmd


def _collapsed_to_flame(lines: list[str], root_path: Path, scale: float, root_name: str) -> FlameNode:
    """Build a FlameNode tree from collapsed stack lines ('f1;f2;f3 weight')."""
    tree: dict[str, dict] = {"children": {}, "val": 0.0, "self": 0.0, "cat": "app", "detail": ""}
    for raw in lines:
        raw = raw.strip()
        if not raw or " " not in raw:
            continue
        stack_part, weight_str = raw.rsplit(" ", 1)
        try:
            w = float(weight_str) * scale
        except ValueError:
            continue
        if w <= 0:
            continue
        frames = [f.strip() for f in stack_part.split(";") if f.strip()]
        if not frames:
            continue
        tree["val"] += w
        cur = tree
        for idx, frame in enumerate(frames):
            # py-spy format often looks like `func (path/file.py:42)`
            m = re.match(r"^(.*?)\s*\((.+):(\d+)\)$", frame)
            if m:
                fn_name, fpath, lineno = m.group(1), m.group(2), int(m.group(3))
                cat = _classify_path(fpath, root_path)
                loc = _short_loc(fpath, lineno, root_path)
                label = f"{fn_name} [{Path(fpath).name}:{lineno}]"
            else:
                cat = "native" if "<" in frame or "::" in frame else "lib"
                loc = ""
                label = frame
            nxt = cur["children"].setdefault(label, {"children": {}, "val": 0.0, "self": 0.0, "cat": cat, "detail": loc})
            nxt["val"] += w
            if idx == len(frames) - 1:
                nxt["self"] += w
            cur = nxt

    def build(name: str, d: dict) -> FlameNode:
        return FlameNode(
            name=name,
            value=d["val"],
            self_value=d["self"],
            category=d["cat"],
            detail=d["detail"],
            children=[build(k, v) for k, v in d["children"].items()],
        )

    return build(root_name, tree)


# --------------------------------------------------------- CPU profilers

_CPROFILE_DRIVER = r"""
import cProfile, json, pstats, runpy, sys
prof_out, json_out, mode, target = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
sys.argv = [target] + sys.argv[5:]
if "." not in sys.path:
    sys.path.insert(0, ".")
pr = cProfile.Profile()
pr.enable()
try:
    if mode == "-m":
        runpy.run_module(target, run_name="__main__", alter_sys=True)
    else:
        runpy.run_path(target, run_name="__main__")
finally:
    pr.disable()
    pr.dump_stats(prof_out)
    st = pstats.Stats(pr)
    rows = []
    id_of = {}
    for idx, func in enumerate(st.stats.keys()):
        id_of[func] = idx
    for func, (cc, nc, tt, ct, callers) in st.stats.items():
        rows.append({
            "id": id_of[func],
            "file": func[0],
            "line": func[1],
            "name": func[2],
            "cc": cc,
            "nc": nc,
            "tt": tt,
            "ct": ct,
            "callers": [[id_of[k], v[3] if isinstance(v, tuple) else v] for k, v in callers.items() if k in id_of],
        })
    with open(json_out, "w", encoding="utf-8") as fh:
        json.dump({"total_tt": st.total_tt, "rows": rows}, fh)
"""


def _subprocess_wait_notes(top_cum: list[dict], top_self: list[dict]) -> list[str]:
    """Warn when an in-process profiler is dominated by waiting on child worker processes."""
    markers = ("multiprocessing", "concurrent/futures", "subprocess", "imapiterator", "pool.", "popen.wait")
    hit_pct = 0.0
    for row in top_cum + top_self:
        sig = f"{row.get('function', '')} {row.get('where', '')}".lower().replace("\\", "/")
        if any(m in sig for m in markers):
            hit_pct = max(hit_pct, float(row.get("pct", 0.0)))
    if hit_pct >= 20.0:
        return [
            f"In-process profiler spent {hit_pct:.1f}% waiting on child workers (`multiprocessing`/`subprocess`). "
            "Worker CPU does NOT appear in this flame graph — install `py-spy` (`--subprocesses`) or emit "
            "single-process `PERF_METRIC` timings to measure worker hotspots directly."
        ]
    return []
def _split_py_entry(py_argv: list[str]) -> tuple[str, str, list[str]] | None:
    """Parse ['-m', 'pkg.mod', 'a'] or ['script.py', 'a'] while ignoring leading -X/-W flags."""
    i = 0
    while i < len(py_argv):
        tok = py_argv[i]
        if tok == "-m" and i + 1 < len(py_argv):
            return "-m", py_argv[i + 1], py_argv[i + 2:]
        if tok in ("-X", "-W") and i + 1 < len(py_argv):
            i += 2
            continue
        if tok.startswith("-"):
            i += 1
            continue
        return "path", tok, py_argv[i + 1:]
    return None


def profile_cpu(root: Path, store: Path, name: str, python: str, py_argv: list[str],
                shell_cmd: str, timeout: float) -> dict:
    """Profile CPU/wall time using py-spy -> pyinstrument -> cProfile fallback, and write an SVG flame graph."""
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    svg_file = store / f"profile-{name}-cpu.svg"

    # 1. Try py-spy (zero-overhead native-capable sampling)
    pyspy = find_tool_near_python(python, "py-spy")
    if pyspy and py_argv:
        with tempfile.TemporaryDirectory() as tmp:
            raw_path = Path(tmp) / "pyspy.raw"
            proc = subprocess.run(
                [pyspy, "record", "--format", "raw", "--rate", "250", "--subprocesses",
                 "-o", str(raw_path), "--", python, *py_argv],
                cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, env=env,
            )
            if proc.returncode == 0 and raw_path.is_file():
                raw_lines = [ln for ln in raw_path.read_text(encoding="utf-8", errors="replace").splitlines() if ln.strip()]
                if raw_lines:
                    flame = _collapsed_to_flame(raw_lines, root, 1.0 / 250.0, f"{name} (py-spy)")
                    if flame.value > 0:
                        svg_file.write_text(
                            render_flame_svg(flame, f"CPU / Wall Flame Graph — {name}",
                                             f"Sampler: py-spy (250 Hz, sampled ~{flame.value:.2f}s)", "s"),
                            encoding="utf-8",
                        )
                        hotspots = _top_leaf_nodes(flame)
                        return {
                            "tool": "py-spy",
                            "total_sec": round(flame.value, 4),
                            "svg": svg_file.relative_to(root).as_posix(),
                            "top_cumulative": hotspots["cum"],
                            "top_self": hotspots["self"],
                        }

    # 2. Try pyinstrument (low-overhead wall-clock call-tree sampler)
    if py_argv and python_has_module(python, "pyinstrument"):
        with tempfile.TemporaryDirectory() as tmp:
            json_path = Path(tmp) / "pyinst.json"
            proc = subprocess.run(
                [python, "-m", "pyinstrument", "-r", "json", "-o", str(json_path), *py_argv],
                cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, env=env,
            )
            if proc.returncode == 0 and json_path.is_file():
                data = json.loads(json_path.read_text(encoding="utf-8"))
                rf = data.get("root_frame")
                if rf and float(rf.get("time", 0.0)) > 0:
                    def conv(f: dict) -> FlameNode:
                        fn = f.get("function") or "<frame>"
                        fp = f.get("file_path") or f.get("file_path_short") or ""
                        ln = int(f.get("line_no") or 0)
                        val = float(f.get("time") or 0.0)
                        kids = [conv(c) for c in f.get("children", [])]
                        self_t = max(0.0, val - sum(k.value for k in kids))
                        cat = "app" if f.get("is_application_code") else _classify_path(fp, root)
                        loc = _short_loc(fp, ln, root)
                        return FlameNode(f"{fn} [{Path(fp).name}:{ln}]" if fp else fn, val, self_t, cat, loc, kids)

                    flame = conv(rf)
                    flame.name = f"{name} (pyinstrument)"
                    svg_file.write_text(
                        render_flame_svg(flame, f"Wall-Clock Call Tree — {name}",
                                         f"Sampler: pyinstrument (duration {flame.value:.3f}s, includes I/O waits)", "s"),
                        encoding="utf-8",
                    )
                    hotspots = _top_leaf_nodes(flame)
                    return {
                        "tool": "pyinstrument",
                        "total_sec": round(flame.value, 4),
                        "svg": svg_file.relative_to(root).as_posix(),
                        "top_cumulative": hotspots["cum"],
                        "top_self": hotspots["self"],
                        "notes": _subprocess_wait_notes(hotspots["cum"], hotspots["self"]),
                    }

    # 3. Standard-library cProfile fallback (always works across Linux/macOS/Windows)
    entry = _split_py_entry(py_argv)
    if not entry:
        raise RuntimeError(
            f"Cannot attach cProfile to non-Python command `{shell_cmd}` (and py-spy was unavailable). "
            "Pass target='-m pkg.module ...' or install py-spy."
        )
    mode_flag, target_str, rest_args = entry
    prof_file = store / f"profile-{name}.prof"
    with tempfile.TemporaryDirectory() as tmp:
        stats_json = Path(tmp) / "cprof.json"
        proc = subprocess.run(
            [python, "-c", _CPROFILE_DRIVER, str(prof_file), str(stats_json), mode_flag, target_str, *rest_args],
            cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, env=env,
        )
        if proc.returncode != 0 or not stats_json.is_file():
            tail = "\n".join((proc.stderr or proc.stdout).strip().splitlines()[-15:])
            raise RuntimeError(f"cProfile target failed (exit {proc.returncode}):\n{tail}")
        raw = json.loads(stats_json.read_text(encoding="utf-8"))

    flame, cum_rows, self_rows = _cprofile_to_flame(raw, root, name)
    svg_file.write_text(
        render_flame_svg(flame, f"CPU Profile — {name}",
                         f"Profiler: stdlib cProfile (total {flame.value:.4f}s; saved {prof_file.name})", "s"),
        encoding="utf-8",
    )
    return {
        "tool": "cProfile",
        "total_sec": round(flame.value, 4),
        "svg": svg_file.relative_to(root).as_posix(),
        "prof_file": prof_file.relative_to(root).as_posix(),
        "top_cumulative": cum_rows[:12],
        "top_self": self_rows[:12],
        "notes": _subprocess_wait_notes(cum_rows[:12], self_rows[:12]),
    }


def _top_leaf_nodes(flame: FlameNode) -> dict[str, list[dict]]:
    cum: dict[str, list] = defaultdict(lambda: [0.0, 0.0, ""])
    own: dict[str, list] = defaultdict(lambda: [0.0, 0.0, ""])

    def walk(node: FlameNode, depth: int, seen_in_stack: set[str]) -> None:
        if depth > 0 and node.category != "other":
            own[node.name][0] += node.self_value
            own[node.name][1] += node.value
            own[node.name][2] = node.detail
            if node.name not in seen_in_stack:
                cum[node.name][0] += node.value
                cum[node.name][1] += node.self_value
                cum[node.name][2] = node.detail
        nxt_seen = seen_in_stack | {node.name}
        for ch in node.children:
            walk(ch, depth + 1, nxt_seen)

    walk(flame, 0, set())
    total = max(flame.value, 1e-9)
    cum_list = [
        {"function": k, "cum_sec": round(v[0], 4), "self_sec": round(v[1], 4),
         "pct": round(100.0 * v[0] / total, 1), "where": v[2]}
        for k, v in sorted(cum.items(), key=lambda kv: -kv[1][0])[:12]
    ]
    self_list = [
        {"function": k, "self_sec": round(v[0], 4), "cum_sec": round(v[1], 4),
         "pct": round(100.0 * v[0] / total, 1), "where": v[2]}
        for k, v in sorted(own.items(), key=lambda kv: -kv[1][0])[:12] if v[0] > 0
    ]
    return {"cum": cum_list, "self": self_list}


def _cprofile_to_flame(raw: dict, root_path: Path, name: str) -> tuple[FlameNode, list[dict], list[dict]]:
    rows = raw["rows"]
    total = max(float(raw.get("total_tt") or 0.0), 1e-9)
    by_id = {r["id"]: r for r in rows}
    children_map: dict[int, list[tuple[int, float]]] = defaultdict(list)
    incoming_total: dict[int, float] = defaultdict(float)
    for r in rows:
        for caller_id, edge_ct in r["callers"]:
            if caller_id != r["id"]:
                w = float(edge_ct) if isinstance(edge_ct, (int, float)) else float(r["ct"])
                children_map[caller_id].append((r["id"], w))
                incoming_total[r["id"]] += w

    # Ignore profiler / module-loader wrapper frames so user code starts at the top of the chart
    def is_driver(r: dict) -> bool:
        fp = r["file"].replace("\\", "/")
        if fp == "<string>" or "runpy" in fp or "<frozen importlib" in fp:
            return True
        if r["file"] in ("~", "<built-in>") and "builtins.exec" in r["name"]:
            return True
        return False

    candidates = [r for r in rows if not is_driver(r)]
    roots = [r for r in candidates if incoming_total[r["id"]] == 0 or all(is_driver(by_id[c]) for c, _ in r["callers"])]
    if not roots and candidates:
        roots = [max(candidates, key=lambda r: r["ct"])]

    def label_of(r: dict) -> tuple[str, str, str]:
        cat = _classify_path(r["file"], root_path)
        loc = _short_loc(r["file"], r["line"], root_path)
        if cat == "native":
            return r["name"], cat, f"{r['nc']} calls"
        return f"{r['name']} [{Path(r['file']).name}:{r['line']}]", cat, f"{loc} ({r['nc']} calls)"

    def expand(rid: int, alloc_ct: float, stack: frozenset[int], depth: int) -> FlameNode:
        r = by_id[rid]
        lbl, cat, detail = label_of(r)
        base_ct = max(float(r["ct"]), 1e-9)
        scale = min(1.0, alloc_ct / base_ct)
        self_v = float(r["tt"]) * scale
        kids: list[FlameNode] = []
        if depth < 15:
            budget = max(0.0, alloc_ct - self_v)
            raw_kids = [(cid, cw * scale) for cid, cw in children_map.get(rid, []) if cid not in stack and not is_driver(by_id[cid])]
            sum_kw = sum(w for _, w in raw_kids)
            norm = min(1.0, budget / sum_kw) if sum_kw > 0 else 0.0
            for cid, kw in sorted(raw_kids, key=lambda x: -x[1]):
                val = kw * norm
                if val >= total * 0.002:
                    kids.append(expand(cid, val, stack | {rid}, depth + 1))
        return FlameNode(lbl, alloc_ct, self_v, cat, detail, kids)

    root_kids = []
    root_sum = sum(float(r["ct"]) for r in roots)
    root_norm = min(1.0, total / root_sum) if root_sum > total else 1.0
    for r in sorted(roots, key=lambda x: -x["ct"])[:12]:
        val = float(r["ct"]) * root_norm
        if val > 0:
            root_kids.append(expand(r["id"], val, frozenset({r["id"]}), 1))

    flame = FlameNode(f"{name} (cProfile)", total, 0.0, "app", "", root_kids)

    cum_rows = []
    for r in sorted(candidates, key=lambda x: -x["ct"])[:15]:
        lbl, _, detail = label_of(r)
        cum_rows.append({
            "function": lbl, "cum_sec": round(r["ct"], 4), "self_sec": round(r["tt"], 4),
            "calls": r["nc"], "pct": round(100.0 * r["ct"] / total, 1), "where": detail,
        })
    self_rows = []
    for r in sorted(candidates, key=lambda x: -x["tt"])[:15]:
        if r["tt"] <= 0:
            continue
        lbl, _, detail = label_of(r)
        self_rows.append({
            "function": lbl, "self_sec": round(r["tt"], 4), "cum_sec": round(r["ct"], 4),
            "calls": r["nc"], "pct": round(100.0 * r["tt"] / total, 1), "where": detail,
        })
    return flame, cum_rows, self_rows


# --------------------------------------------------------- Memory profilers

_TRACEMALLOC_DRIVER = r"""
import json, linecache, runpy, sys, tracemalloc
json_out, mode, target = sys.argv[1], sys.argv[2], sys.argv[3]
sys.argv = [target] + sys.argv[4:]
if "." not in sys.path:
    sys.path.insert(0, ".")
tracemalloc.start(25)
snap = None
cur_b = peak_b = 0
cuda_peak_mb = None
try:
    if mode == "-m":
        runpy.run_module(target, run_name="__main__", alter_sys=True)
    else:
        runpy.run_path(target, run_name="__main__")
finally:
    cur_b, peak_b = tracemalloc.get_traced_memory()
    snap = tracemalloc.take_snapshot()
    tracemalloc.stop()
    if "torch" in sys.modules:
        try:
            import torch
            if torch.cuda.is_available():
                cuda_peak_mb = round(torch.cuda.max_memory_allocated() / 1048576.0, 2)
        except Exception:
            pass
    snap = snap.filter_traces((
        tracemalloc.Filter(False, "<frozen importlib._bootstrap*"),
        tracemalloc.Filter(False, "<frozen runpy>"),
        tracemalloc.Filter(False, "<unknown>"),
        tracemalloc.Filter(False, tracemalloc.__file__),
    ))
    top_lines = []
    for st in snap.statistics("lineno")[:20]:
        fr = st.traceback[0]
        top_lines.append({"file": fr.filename, "line": fr.lineno, "size_b": st.size, "count": st.count})
    traces = []
    for st in snap.statistics("traceback")[:200]:
        # reversed: outer caller -> allocation leaf
        frames = [{"file": f.filename, "line": f.lineno, "code": linecache.getline(f.filename, f.lineno).strip()[:48]}
                  for f in reversed(st.traceback)]
        traces.append({"size_b": st.size, "count": st.count, "frames": frames})
    with open(json_out, "w", encoding="utf-8") as fh:
        json.dump({
            "current_mb": round(cur_b / 1048576.0, 3),
            "peak_py_mb": round(peak_b / 1048576.0, 3),
            "cuda_peak_mb": cuda_peak_mb,
            "top_lines": top_lines,
            "traces": traces,
        }, fh)
"""


def profile_memory(root: Path, store: Path, name: str, python: str, py_argv: list[str],
                   shell_cmd: str, timeout: float) -> dict:
    """Measure OS Peak RSS (native + Python), optional memray stats, and tracemalloc allocation flame graph."""
    # Always get true un-distorted OS Peak RSS first
    sample = run_measured_command(shell_cmd, root, timeout)
    if sample.returncode != 0:
        tail = "\n".join((sample.stderr or sample.stdout).strip().splitlines()[-15:])
        raise RuntimeError(f"Memory target failed (exit {sample.returncode}):\n{tail}")

    entry = _split_py_entry(py_argv)
    svg_file = store / f"profile-{name}-memory.svg"
    memray_info: dict | None = None
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"}

    # Try Memray on POSIX when installed (captures native C/C++/Rust allocations too!)
    if os.name != "nt" and py_argv and python_has_module(python, "memray"):
        with tempfile.TemporaryDirectory() as tmp:
            bin_path = Path(tmp) / "mem.bin"
            stats_path = Path(tmp) / "mem.json"
            r1 = subprocess.run([python, "-m", "memray", "run", "-f", "-o", str(bin_path), *py_argv],
                                cwd=root, capture_output=True, text=True, timeout=timeout, env=env)
            if r1.returncode == 0 and bin_path.is_file():
                r2 = subprocess.run([python, "-m", "memray", "stats", "--json", "-o", str(stats_path), str(bin_path)],
                                    cwd=root, capture_output=True, text=True, timeout=60, env=env)
                if r2.returncode == 0 and stats_path.is_file():
                    memray_info = json.loads(stats_path.read_text(encoding="utf-8"))

    if not entry:
        return {
            "tool": "os-rss",
            "peak_rss_mb": sample.peak_mb,
            "peak_py_mb": None,
            "cuda_peak_mb": None,
            "svg": None,
            "top_allocations": [],
            "notes": ["Non-Python shell command: reported OS Peak RSS only."],
        }

    mode_flag, target_str, rest_args = entry
    with tempfile.TemporaryDirectory() as tmp:
        tm_json = Path(tmp) / "tm.json"
        proc = subprocess.run(
            [python, "-c", _TRACEMALLOC_DRIVER, str(tm_json), mode_flag, target_str, *rest_args],
            cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, env=env,
        )
        if proc.returncode != 0 or not tm_json.is_file():
            tail = "\n".join((proc.stderr or proc.stdout).strip().splitlines()[-15:])
            raise RuntimeError(f"tracemalloc run failed (exit {proc.returncode}):\n{tail}")
        tm = json.loads(tm_json.read_text(encoding="utf-8"))

    # Build allocation tree from tracemalloc traces
    collapsed: list[str] = []
    for tr in tm.get("traces", []):
        mb = tr["size_b"] / 1048576.0
        if mb <= 0:
            continue
        parts = []
        for fr in tr["frames"]:
            if "<string>" in fr["file"] or "runpy.py" in fr["file"].replace("\\", "/"):
                continue
            code = fr["code"] or Path(fr["file"]).name
            parts.append(f"{code} ({fr['file']}:{fr['line']})")
        if parts:
            collapsed.append(f"{';'.join(parts)} {mb:.6f}")

    svg_rel: str | None = None
    if collapsed:
        flame = _collapsed_to_flame(collapsed, root, 1.0, f"{name} retained Python heap")
        if flame.value > 0:
            sub = f"OS Peak RSS: {sample.peak_mb or '?'} MB | Peak Python heap (tracemalloc): {tm['peak_py_mb']} MB"
            svg_file.write_text(
                render_flame_svg(flame, f"Memory Allocation Call Tree — {name}", sub, "MB"),
                encoding="utf-8",
            )
            svg_rel = svg_file.relative_to(root).as_posix()

    top_allocs = [
        {"where": _short_loc(item["file"], item["line"], root),
         "mb": round(item["size_b"] / 1048576.0, 3), "blocks": item["count"]}
        for item in tm.get("top_lines", [])[:12]
    ]
    notes: list[str] = []
    if sample.peak_mb and tm["peak_py_mb"] is not None and sample.peak_mb > max(80.0, tm["peak_py_mb"] * 3.0):
        notes.append(
            f"OS Peak RSS ({sample.peak_mb} MB) is much larger than traced Python heap ({tm['peak_py_mb']} MB): "
            "most memory lives in native C/C++/Rust buffers (NumPy arrays, Shapely geometries, laspy clouds, "
            "OpenCV images or PyTorch tensors). Check array copies, dtypes and chunked processing."
        )
    tool_used = "memray + tracemalloc + OS RSS" if memray_info else "tracemalloc + OS RSS"
    if memray_info and isinstance(memray_info.get("metadata"), dict):
        m_peak = memray_info["metadata"].get("peak_memory")
        if isinstance(m_peak, (int, float)):
            notes.append(f"Memray native+Python peak heap: {m_peak / 1048576.0:.2f} MB.")

    return {
        "tool": tool_used,
        "peak_rss_mb": sample.peak_mb,
        "peak_py_mb": tm["peak_py_mb"],
        "retained_py_mb": tm["current_mb"],
        "cuda_peak_mb": tm["cuda_peak_mb"],
        "svg": svg_rel,
        "top_allocations": top_allocs,
        "notes": notes,
    }


# --------------------------------------------------------- Import-time profiler

def profile_imports(root: Path, store: Path, name: str, python: str, py_argv: list[str], timeout: float) -> dict:
    """Run `python -X importtime`, build the exact import hierarchy, and render an SVG flame graph."""
    if not py_argv:
        raise RuntimeError("import profile requires Python arguments (e.g. target='-c \"import pkg\"' or '-m pkg.cli --help')")
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    proc = subprocess.run(
        [python, "-X", "importtime", *py_argv],
        cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, env=env,
    )
    # `-X importtime` prints in bottom-up post-order with 2-space indentation per nesting level!
    parsed: list[tuple[int, float, float, str]] = []
    pat = re.compile(r"^import time:\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(.*)$")
    for ln in proc.stderr.splitlines():
        m = pat.match(ln)
        if not m:
            continue
        self_ms = int(m.group(1)) / 1000.0
        cum_ms = int(m.group(2)) / 1000.0
        raw_pkg = m.group(3)
        depth = (len(raw_pkg) - len(raw_pkg.lstrip(" "))) // 2
        pkg = raw_pkg.strip()
        if pkg:
            parsed.append((depth, self_ms, cum_ms, pkg))

    if not parsed:
        tail = "\n".join((proc.stderr or proc.stdout).strip().splitlines()[-10:])
        raise RuntimeError(f"No `-X importtime` records captured (exit {proc.returncode}):\n{tail}")

    # Reconstruct parent-child tree from post-order indentation
    stack: list[tuple[int, FlameNode]] = []
    for depth, self_ms, cum_ms, pkg in parsed:
        kids: list[FlameNode] = []
        while stack and stack[-1][0] > depth:
            kids.append(stack.pop()[1])
        kids.reverse()
        top_pkg = pkg.split(".")[0]
        cat = "app" if (root / top_pkg).exists() or (root / "src" / top_pkg).exists() else "lib"
        node = FlameNode(pkg, cum_ms, self_ms, cat, f"self {self_ms:.2f} ms", kids)
        stack.append((depth, node))

    top_nodes = [n for _, n in stack]
    total_ms = sum(n.value for n in top_nodes)
    flame = FlameNode(f"{name} imports", total_ms, 0.0, "app", "", top_nodes)
    svg_file = store / f"profile-{name}-import.svg"
    svg_file.write_text(
        render_flame_svg(flame, f"Startup Import Time — {name}",
                         f"Profiler: python -X importtime (total {total_ms:.1f} ms across {len(parsed)} imports)", "ms"),
        encoding="utf-8",
    )
    slowest = sorted(parsed, key=lambda r: -r[2])[:12]
    slowest_self = sorted(parsed, key=lambda r: -r[1])[:10]
    return {
        "tool": "python -X importtime",
        "total_ms": round(total_ms, 2),
        "svg": svg_file.relative_to(root).as_posix(),
        "top_cumulative": [{"module": p, "cum_ms": round(c, 2), "self_ms": round(s, 2)} for _, s, c, p in slowest],
        "top_self": [{"module": p, "self_ms": round(s, 2), "cum_ms": round(c, 2)} for _, s, c, p in slowest_self],
    }
