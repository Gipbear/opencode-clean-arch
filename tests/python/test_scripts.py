import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "skills" / "clean-arch" / "scripts"
FIXTURE = ROOT / "tests" / "fixtures" / "sample_repo"


def _rmtree_onerror(func, path, _exc):
    os.chmod(path, stat.S_IWRITE)
    func(path)


def run(script: str, repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPTS / script), "--root", str(repo), *args],
                          capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)


class FixtureRepo(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        shutil.copytree(FIXTURE, self.repo)

    def tearDown(self):
        shutil.rmtree(self.tmp, onerror=_rmtree_onerror)

    def git(self, *args: str):
        subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=self.repo,
                       check=True, capture_output=True)


class LeftoverScanTest(FixtureRepo):
    def findings(self, *args: str) -> list[dict]:
        result = run("leftover_scan.py", self.repo, "--format", "json", "--fail-on", "never", *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_reports_each_planted_leftover(self):
        found = {(f["category"], f["path"]) for f in self.findings()}
        expected = {
            ("broken-import", "shop/services/report.py"),
            ("compat-shim", "shop/services/legacy.py"),
            ("parallel-version", "shop/services/billing_v2.py"),
            ("parallel-version", "web/app.js"),
            ("commented-code", "shop/services/report.py"),
            ("debug", "shop/services/report.py"),
            ("version-name", "shop/services/billing_v2.py"),
            ("narrative-comment", "shop/services/report.py"),
        }
        self.assertLessEqual(expected, found)

    def test_identical_files_are_reported_once_per_group(self):
        identical = [f for f in self.findings() if "identical" in f["message"]]
        self.assertEqual(sorted(f["path"] for f in identical), ["shop/services/billing.py", "web/app.js"])

    def test_alias_and_import_fallback_are_compat_shims(self):
        lines = sorted(f["line"] for f in self.findings()
                       if f["category"] == "compat-shim" and f["path"] == "shop/services/legacy.py")
        self.assertEqual(lines, [5, 9])

    def test_forwarding_module_is_a_compat_shim(self):
        shims = [f for f in self.findings() if f["category"] == "compat-shim"]
        self.assertTrue(any(f["path"] == "shop/services/paths.py" and "re-exports" in f["message"] for f in shims))

    def test_numbered_format_family_is_not_a_version_leftover(self):
        self.assertFalse([f for f in self.findings() if "render_v" in f["message"]])

    def test_exit_code(self):
        self.assertEqual(run("leftover_scan.py", self.repo).returncode, 0)
        self.assertEqual(run("leftover_scan.py", self.repo, "--fail-on", "high").returncode, 1)

    def test_clean_repository_passes(self):
        for name in ["billing_v2.py", "legacy.py", "report.py", "paths.py"]:
            (self.repo / "shop" / "services" / name).unlink()
        shutil.rmtree(self.repo / "web_copy")
        (self.repo / "web" / "app.js").write_text(
            (self.repo / "web" / "app.js").read_text().replace('  console.log("render", items)\n', ""))
        result = run("leftover_scan.py", self.repo, "--fail-on", "medium")
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_since_limits_findings_to_changed_files(self):
        self.git("init", "-q")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        (self.repo / "shop" / "core" / "extra.py").write_text("# old version kept below\ndef total_old():\n    return 1\n")
        paths = {f["path"] for f in self.findings("--since", "HEAD")}
        self.assertEqual(paths, {"shop/core/extra.py"})

    def test_since_keeps_duplicates_when_one_copy_changed(self):
        self.git("init", "-q")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        copy = self.repo / "shop" / "services" / "billing_copy.py"
        copy.write_text((self.repo / "shop" / "services" / "billing.py").read_text())
        identical = [f for f in self.findings("--since", "HEAD") if "identical" in f["message"]]
        self.assertTrue(identical)
        self.assertTrue(any(p.endswith("billing_copy.py") for f in identical for p in [f["path"], *f["related"]]))


class ArchFactsTest(FixtureRepo):
    def facts(self) -> dict:
        result = run("arch_facts.py", self.repo, "json")
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_detects_cycles_unresolved_imports_and_duplicates(self):
        facts = self.facts()
        self.assertIn(["shop.core", "shop.services"], [sorted(c) for c in facts["package_cycles"]])
        self.assertTrue(any("Missing" in str(u) for u in facts["unresolved_internal_imports"]))
        identical = facts["duplicates"]["identical_files"]
        self.assertIn(["shop/services/billing.py", "shop/services/billing_v2.py"], identical)
        self.assertIn(["web/app.js", "web_copy/app.js"], identical)

    def test_copies_with_renamed_variables(self):
        renamed = self.facts()["duplicates"]["renamed_functions"]
        self.assertEqual([sorted(e["function"] for e in g) for g in renamed], [["big_order_stats", "summarize"]])

    def test_importers_lists_imports_tests_and_text_mentions(self):
        result = run("arch_facts.py", self.repo, "importers", "shop.services.notify")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("`shop/core/pricing.py:3`", result.stdout)
        self.assertIn("`Dockerfile:3`", result.stdout)
        tests = run("arch_facts.py", self.repo, "importers", "shop/services/billing.py")
        self.assertIn("(test)", tests.stdout)

    def test_brief_summary(self):
        result = run("arch_facts.py", self.repo, "summary", "--brief")
        self.assertIn("| Package cycles / module cycles | 1 / 1 |", result.stdout)

    def test_package_diagram_keeps_every_cycle_member(self):
        diagram = run("arch_facts.py", self.repo, "mermaid", "--max-nodes", "1").stdout
        self.assertIn('n_shop_core["shop.core"]', diagram)
        self.assertIn('n_shop_services["shop.services"]', diagram)

    def test_summary_and_mermaid(self):
        summary = run("arch_facts.py", self.repo, "summary")
        self.assertEqual(summary.returncode, 0, summary.stderr)
        self.assertIn("shop.core", summary.stdout)
        diagram = run("arch_facts.py", self.repo, "mermaid", "--view", "packages")
        self.assertTrue(diagram.stdout.startswith("flowchart"), diagram.stdout)

    def test_class_diagram_ranks_abstractions_and_draws_relations(self):
        diagram = run("arch_facts.py", self.repo, "mermaid", "--view", "classes").stdout
        self.assertTrue(diagram.startswith("classDiagram\n  class Channel {\n    <<abstract>>"), diagram)
        self.assertIn("Channel <|-- EmailChannel", diagram)
        self.assertIn("Dispatcher --> Channel : channel", diagram)
        self.assertNotIn("_Scratch", diagram)

    def test_process_calls_from_subprocess_and_scripts(self):
        calls = {(c["path"], c["to"]) for c in self.facts()["process_calls"]}
        self.assertEqual(calls, {("shop/jobs.py", "shop.services.report"), ("Dockerfile", "shop.services.notify")})
        diagram = run("arch_facts.py", self.repo, "mermaid").stdout
        self.assertIn("n_shop -.->|subprocess| n_shop_services", diagram)

    def test_verify_diagrams_against_code(self):
        docs = self.repo / "docs"
        docs.mkdir()
        (docs / "ok.mmd").write_text(
            'flowchart TD\n  svc["shop.services"] --> core["shop.core"]\n'
            '  jobs["shop/jobs.py"] -.->|subprocess| rep["shop.services.report"]\n  user([用户]) --> jobs\n',
            encoding="utf-8")
        self.assertEqual(run("arch_facts.py", self.repo, "verify", "docs/ok.mmd").returncode, 0)
        (docs / "plan.md").write_text(
            "# Plan\n\n```mermaid\nflowchart LR\n  m[\"shop.core.models\"] --> p[\"shop.core.pricing\"]\n"
            "  g[\"shop.ghost\"] --> m\n```\n\n```mermaid\nclassDiagram\n  class Ghost\n"
            "  Dispatcher <|-- EmailChannel\n```\n",
            encoding="utf-8")
        result = run("arch_facts.py", self.repo, "verify", "docs/plan.md")
        self.assertEqual(result.returncode, 1)
        for expected in ["plan.md:5` `shop.core.models` does not import `shop.core.pricing` (the arrow is reversed)",
                         "plan.md:6` `shop.ghost` does not exist", "plan.md:11` class `Ghost` does not exist",
                         "plan.md:12` `EmailChannel` does not inherit from `Dispatcher`"]:
            self.assertIn(expected, result.stdout)

    def test_rules_check(self):
        rules = self.repo / ".clean-arch" / "rules.toml"
        rules.parent.mkdir()
        rules.write_text(
            "no_cycles = true\n\n"
            '[[layers]]\nname = "services"\nmodules = ["shop.services*"]\n\n'
            '[[layers]]\nname = "core"\nmodules = ["shop.core*"]\n\n'
            "[budgets]\nmax_params = 1\n")
        result = run("arch_facts.py", self.repo, "check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("layer: `shop.core.pricing`", result.stdout)
        self.assertIn("budget:", result.stdout)
        self.assertIn("cycle:", result.stdout)
        self.assertRegex(result.stdout, r"\d+ violation\(s\): layer 1, cycle 1, budget \d+ in \d+ files")
        self.assertIn("modules match no layer and are not layer-checked: shop (2)", result.stdout)

    def test_misplaced_rule_key_warns(self):
        rules = self.repo / ".clean-arch" / "rules.toml"
        rules.parent.mkdir()
        rules.write_text("[budgets]\nmax_params = 9\nno_cycles = true\n")
        result = run("arch_facts.py", self.repo, "check")
        self.assertIn("budgets.no_cycles", result.stderr)

    def test_rules_template_parses(self):
        template = ROOT / "skills" / "arch-map" / "references" / "templates" / "ai" / "rules.toml"
        result = run("arch_facts.py", self.repo, "check", "--rules", str(template))
        self.assertIn("violation(s)", result.stdout, result.stderr)

    def test_architecture_signals_on_fixture(self):
        facts = self.facts()
        models = [m["name"] for m in facts["data_models"]]
        self.assertEqual(models, ["Order"])
        sig = facts["architecture_signals"]
        self.assertTrue(any(r["keys"] == ["average", "count", "total"] and r["modules"] >= 2
                            for r in sig["repeated_dict_keys"]), sig["repeated_dict_keys"])
        self.assertTrue(any(b["path"] == "shop/core/stats.py" and b["function"] == "summarize"
                            for b in sig["dict_boundaries"]), sig["dict_boundaries"])
        self.assertTrue(any(g["path"] == "shop/services/utils.py" for g in sig["grab_bag_modules"]))
        self.assertTrue(any(g["path"] == "shop/services/utils.py" and g["kind"] == "mutable-global"
                            for g in sig["global_effects"]), sig["global_effects"])
        self.assertEqual([a["class"] for a in sig["single_impl_abstractions"]], ["Channel"])
        self.assertEqual([o["class"] for o in sig["one_method_classes"]], ["Dispatcher"])
        summary = run("arch_facts.py", self.repo, "summary").stdout
        self.assertIn("Implicit data shapes", summary)
        self.assertIn("Grab-bag modules", summary)
        self.assertIn("Speculative abstractions", summary)

    def test_tangled_orchestrator_impure_core_and_external_forbid(self):
        body = "\n".join([
            "import json",
            "import os",
            "import requests",
            "from shop.core.pricing import total",
            "from shop.services.billing import invoice_lines",
            "",
            "def run_everything(orders, out_path):",
            "    api = os.getenv('BILLING_URL', 'http://localhost')",
            "    rows = []",
            "    for item in orders:",
            "        if item.amount > 0:",
            "            for line in invoice_lines(item, 0.0):",
            "                if line:",
            "                    rows.append((line, total(item, 0.1)))",
        ] + [f"    step_{i} = len(rows) + {i}" for i in range(30)] + [
            "    requests.post(api, json={'n': step_29})",
            "    with open(out_path, 'w', encoding='utf-8') as fh:",
            "        json.dump(rows, fh)",
            "    return rows",
        ])
        (self.repo / "shop" / "core" / "pipeline_mess.py").write_text(body + "\n", encoding="utf-8")
        facts = self.facts()
        sig = facts["architecture_signals"]
        self.assertTrue(any(t["function"] == "run_everything" for t in sig["tangled_orchestrators"]),
                        sig["tangled_orchestrators"])
        self.assertTrue(any(m["path"] == "shop/core/pipeline_mess.py" for m in sig["impure_shared_modules"]),
                        sig["impure_shared_modules"])
        rules = self.repo / ".clean-arch" / "rules.toml"
        rules.parent.mkdir(exist_ok=True)
        rules.write_text(
            '[[forbid]]\nfrom = "shop.core*"\nto = "requests*"\nreason = "core must not do HTTP"\n',
            encoding="utf-8",
        )
        chk = run("arch_facts.py", self.repo, "check")
        self.assertEqual(chk.returncode, 1)
        self.assertIn("forbidden: `shop.core.pipeline_mess` imports `requests` (core must not do HTTP)", chk.stdout)


def write_repo(root: Path, files: dict[str, str]) -> None:
    for rel, text in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


SRC_FILES = {
    "src/__init__.py": "",
    "src/pkg/__init__.py": "",
    "src/pkg/a.py": "from {p}pkg import b\nfrom {p}pkg.c import thing\n\n\ndef run():\n    return b.helper() + thing()\n",
    "src/pkg/b.py": "from {p}pkg.c import thing\n\n\ndef helper():\n    return thing()\n",
    "src/pkg/c.py": "def thing():\n    return 1\n",
    "src/other/__init__.py": "",
    "src/other/use.py": "from {p}pkg.a import run\nfrom {p}pkg.c import nothing\n",
    "tests/test_a.py": "from {p}pkg.a import run\n",
    "run.sh": "python -m {p}pkg.a\n",
}


class SrcLayoutTest(unittest.TestCase):
    """Repositories keep code under src/ but may import it as `src.pkg` or as `pkg`."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def make(self, prefix: str, overrides: dict[str, str] | None = None) -> None:
        files = {rel: text.replace("{p}", prefix) for rel, text in SRC_FILES.items()}
        write_repo(self.repo, {**files, **(overrides or {})})

    def facts(self) -> dict:
        result = run("arch_facts.py", self.repo, "json")
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def check_edges(self, pkg: str, facts: dict) -> None:
        edges = {(e["from"], e["to"]) for e in facts["module_edges"]}
        self.assertIn((f"{pkg}.a", f"{pkg}.b"), edges)
        self.assertIn((f"{pkg}.a", f"{pkg}.c"), edges)
        self.assertIn((f"{pkg}.b", f"{pkg}.c"), edges)

    def test_src_prefixed_imports_resolve(self):
        self.make("src.")
        facts = self.facts()
        self.check_edges("src.pkg", facts)
        self.assertEqual([u["import"] for u in facts["unresolved_internal_imports"]], ["src.pkg.c.nothing"])

    def test_unprefixed_imports_resolve(self):
        self.make("")
        self.check_edges("pkg", self.facts())

    def test_mixed_spellings_meet_in_one_module(self):
        self.make("src.", {"src/pkg/b.py": "from pkg.c import thing\n\n\ndef helper():\n    return thing()\n"})
        self.check_edges("src.pkg", self.facts())

    def test_importers_accepts_both_spellings(self):
        self.make("src.")
        for target in ["src.pkg.a", "pkg.a", "src/pkg/a.py"]:
            out = run("arch_facts.py", self.repo, "importers", target).stdout
            self.assertIn("`src/other/use.py:1`", out, target)
            self.assertIn("`tests/test_a.py:1` (test)", out, target)
            self.assertIn("`run.sh:1`", out, target)

    def test_leftover_scan_reports_only_the_real_broken_import(self):
        for prefix in ["src.", ""]:
            shutil.rmtree(self.repo, ignore_errors=True)
            self.make(prefix)
            result = run("leftover_scan.py", self.repo, "--format", "json", "--fail-on", "never")
            broken = [f for f in json.loads(result.stdout) if f["category"] == "broken-import"]
            self.assertEqual([f["path"] for f in broken], ["src/other/use.py"], prefix)

    def test_try_except_around_a_src_import_is_a_compat_shim(self):
        self.make("src.", {"src/pkg/a.py": "try:\n    from src.pkg.c import thing\nexcept ImportError:\n    thing = None\n"})
        result = run("leftover_scan.py", self.repo, "--format", "json", "--fail-on", "never")
        self.assertTrue(any(f["category"] == "compat-shim" and f["path"] == "src/pkg/a.py"
                            for f in json.loads(result.stdout)), result.stdout)

    def test_imports_from_a_missing_source_root_are_flagged(self):
        write_repo(self.repo, {
            "backend/pkg/__init__.py": "",
            "backend/pkg/a.py": "import json\nfrom pkg import b\n",
            "backend/pkg/b.py": "def f():\n    return 1\n",
            "backend/app.py": "from pkg.a import f\n",
        })
        roots = self.facts()["suspected_source_roots"]
        self.assertEqual([(r["import_root"], r["container"], r["imports"]) for r in roots], [("pkg", "backend", 2)])
        summary = run("arch_facts.py", self.repo, "summary").stdout
        self.assertIn("missing source root?", summary)
        self.assertIn("`pkg` is imported 2 times", summary)
        scan = run("leftover_scan.py", self.repo).stdout
        self.assertIn("> Warning: imports treated as external", scan)

    def test_no_source_root_warning_when_imports_resolve(self):
        self.make("src.")
        self.assertEqual(self.facts()["suspected_source_roots"], [])
        self.assertNotIn("Warning", run("leftover_scan.py", self.repo).stdout)

    def test_warns_when_most_modules_look_unreferenced(self):
        write_repo(self.repo, {f"pkg/m{i}.py": f"def f{i}():\n    return {i}\n" for i in range(10)})
        scan = run("leftover_scan.py", self.repo).stdout
        self.assertIn("10 of 10 modules are reported as never imported", scan)

    def test_import_cycle_through_src_prefix_is_found(self):
        self.make("src.", {"src/pkg/c.py": "from src.pkg import a\n\n\ndef thing():\n    return a\n"})
        facts = self.facts()
        cycles = [sorted(c) for c in facts["module_cycles"]]
        self.assertTrue(any("src.pkg.a" in c and "src.pkg.c" in c for c in cycles), facts["module_cycles"])


PERF_SOURCE = '''\
import numpy as np
from pyproj import Transformer
from shapely.geometry import Point


def project(rows, poly, acc, idx, vals):
    for r in rows:
        t = Transformer.from_crs("EPSG:4326", "EPSG:32650", always_xy=True)
        p = Point(*t.transform(r[0], r[1]))
        poly.contains(p)
    np.add.at(acc, idx, vals)
'''

GOOD_LESSON = "\n".join([
    "## shapely: contains_xy beats Point + contains",
    "- status: verified",
    "- topics: shapely, point-in-polygon",
    "- symptom: 2M points tested against one polygon in a loop",
    "- change: shapely.prepare(poly); shapely.contains_xy(poly, x, y)",
    "- result: 41 s -> 0.9 s (45x), 2M points",
    "- environment: python 3.11, shapely 2.0.4",
])


class PerfCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        write_repo(self.repo, {"job.py": PERF_SOURCE, "tests/test_job.py": PERF_SOURCE})
        self.store = self.tmp / "lessons.md"

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def perf(self, *args: str) -> subprocess.CompletedProcess:
        env = {**os.environ, "CLEAN_ARCH_LESSONS": str(self.store)}
        return subprocess.run([sys.executable, str(SCRIPTS / "perf_check.py"), "--root", str(self.repo), *args],
                              capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, env=env)

    def test_scan_finds_known_patterns_and_skips_tests(self):
        result = self.perf("scan", "--format", "json")
        self.assertEqual(result.returncode, 0, result.stderr)
        found = json.loads(result.stdout)
        rules = {f["rule"] for f in found}
        self.assertTrue({"PERF-PROJ-CREATE-LOOP", "PERF-SHAPELY-POINT-LOOP", "PERF-NP-ADD-AT"} <= rules, rules)
        self.assertTrue(all(f["path"] == "job.py" for f in found), found)
        with_tests = json.loads(self.perf("scan", "--format", "json", "--include-tests").stdout)
        self.assertTrue(any(f["path"].startswith("tests/") for f in with_tests))

    def test_scan_markdown_points_at_the_reference(self):
        out = self.perf("scan").stdout
        self.assertIn("## PERF-PROJ-CREATE-LOOP", out)
        self.assertIn("references/libraries.md", out)

    def test_env_reports_the_interpreter(self):
        result = self.perf("env", "--format", "json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["python"].split(".")[0], str(sys.version_info[0]))

    def test_bench_saves_and_compares(self):
        (self.repo / "m.py").write_text("import sys\nprint('PERF_METRIC inner=' + sys.argv[1])\n", encoding="utf-8")
        base = self.perf("bench", "base", "--cmd", f'"{sys.executable}" m.py 0.5', "--runs", "3", "--warmup", "0")
        self.assertEqual(base.returncode, 0, base.stderr)
        base_json = json.loads((self.repo / ".clean-arch" / "perf" / "bench-base.json").read_text(encoding="utf-8"))
        self.assertIn("peak_mb", base_json["metrics"])
        self.assertTrue(all(v > 0 for v in base_json["metrics"]["peak_mb"]))
        cand = self.perf("bench", "cand", "--cmd", f'"{sys.executable}" m.py 0.1', "--runs", "3", "--warmup", "0",
                         "--compare", "base")
        self.assertEqual(cand.returncode, 0, cand.stderr)
        self.assertRegex(cand.stdout, r"inner \|[^\n]*faster")
        comp_svg = self.repo / ".clean-arch" / "perf" / "bench-cand-vs-base.svg"
        self.assertTrue(comp_svg.is_file())
        svg_text = comp_svg.read_text(encoding="utf-8")
        self.assertTrue(svg_text.startswith("<svg"))
        self.assertIn("faster", svg_text)
        self.assertNotIn("var(", svg_text)
        self.assertNotIn("<script", svg_text)

    def test_profile_cpu_memory_and_import_render_svgs(self):
        (self.repo / "work.py").write_text(
            "RETAINED = []\n\n"
            "def heavy_loop():\n"
            "    total = 0\n"
            "    for i in range(40000):\n"
            "        total += (i * 3) % 7\n"
            "    RETAINED.extend(bytearray(2048) for _ in range(64))\n"
            "    return total\n\n"
            "if __name__ == '__main__':\n"
            "    heavy_loop()\n",
            encoding="utf-8",
        )
        prof = self.perf("profile", "work1", "--mode", "all", "--target", "work.py")
        self.assertEqual(prof.returncode, 0, prof.stderr)
        self.assertIn("CPU / Wall-Clock Profile", prof.stdout)
        self.assertIn("Memory Profile", prof.stdout)
        self.assertIn("OS Peak RSS:", prof.stdout)
        cpu_svg = self.repo / ".clean-arch" / "perf" / "profile-work1-cpu.svg"
        mem_svg = self.repo / ".clean-arch" / "perf" / "profile-work1-memory.svg"
        self.assertTrue(cpu_svg.is_file())
        self.assertTrue(mem_svg.is_file())
        for path in (cpu_svg, mem_svg):
            txt = path.read_text(encoding="utf-8")
            self.assertTrue(txt.startswith("<svg"))
            self.assertNotIn("var(", txt)
            self.assertNotIn("<script", txt)
        self.assertIn("heavy_loop", cpu_svg.read_text(encoding="utf-8"))

        imp = self.perf("profile", "imp1", "--mode", "import", "--target", '-c "import json, urllib.parse"')
        self.assertEqual(imp.returncode, 0, imp.stderr)
        imp_svg = self.repo / ".clean-arch" / "perf" / "profile-imp1-import.svg"
        self.assertTrue(imp_svg.is_file())
        self.assertIn("urllib", imp_svg.read_text(encoding="utf-8"))

    def test_bench_rejects_bad_arguments(self):
        self.assertNotEqual(self.perf("bench", "x", "--cmd", "echo hi", "--runs", "1").returncode, 0)
        self.assertNotEqual(self.perf("bench", "bad name", "--cmd", "echo hi").returncode, 0)
        failing = self.perf("bench", "boom", "--cmd", f'"{sys.executable}" -c "raise SystemExit(3)"', "--runs", "3")
        self.assertNotEqual(failing.returncode, 0)

    def test_lessons_add_search_and_deduplicate(self):
        self.assertIn("No lessons recorded", self.perf("lessons").stdout)
        added = self.perf("lessons", "--entry", GOOD_LESSON)
        self.assertEqual(added.returncode, 0, added.stderr)
        text = self.store.read_text(encoding="utf-8")
        self.assertIn("- date:", text)
        found = self.perf("lessons", "--query", "shapely polygon").stdout
        self.assertIn("contains_xy", found)
        self.assertNotIn("contains_xy", self.perf("lessons", "--query", "opencv").stdout)
        duplicate = self.perf("lessons", "--entry", GOOD_LESSON)
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertEqual(self.store.read_text(encoding="utf-8").count("## shapely"), 1)

    def test_lessons_reject_unmeasured_and_project_specific_entries(self):
        no_numbers = GOOD_LESSON.replace("41 s -> 0.9 s (45x), 2M points", "much faster")
        self.assertNotEqual(self.perf("lessons", "--entry", no_numbers).returncode, 0)
        with_path = GOOD_LESSON.replace("in a loop", "in C:\\Users\\me\\proj")
        self.assertNotEqual(self.perf("lessons", "--entry", with_path).returncode, 0)
        unix_path = GOOD_LESSON.replace("in a loop", "in /home/me/proj")
        self.assertNotEqual(self.perf("lessons", "--entry", unix_path).returncode, 0)
        self.assertFalse(self.store.exists())

    def test_lessons_entry_file_and_metric_units_and_disjoint_verdict(self):
        entry_file = self.repo / "lesson.md"
        entry_file.write_text(GOOD_LESSON.replace("\\n", "\n"), encoding="utf-8")
        res = self.perf("lessons", "--entry-file", str(entry_file))
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertTrue(self.store.is_file())

        # Verify infer_metric_unit + disjoint range detection + count rendering in bench SVG
        sys.path.insert(0, str(SCRIPTS))
        import perf_check as pc
        import perf_viz as pv

        self.assertEqual(pv.infer_metric_unit("parsed_lines"), ("", "count"))
        self.assertEqual(pv.infer_metric_unit("inline_parse_s"), ("s", "time"))
        self.assertEqual(pv.infer_metric_unit("peak_mb"), ("MB", "memory"))
        baseline = {"metrics": {"peak_mb": [151.0, 154.0, 155.0], "parsed_lines": [30000.0, 30000.0, 30000.0]}}
        cand_stats = {
            "peak_mb": pc.stats([158.0, 158.5, 160.0]),
            "parsed_lines": pc.stats([30000.0, 30000.0, 30000.0]),
        }
        rows = pc.compute_comparisons(cand_stats, baseline, 0.05)
        by_name = {r["metric"]: r for r in rows}
        self.assertEqual(by_name["peak_mb"]["verdict"], "HIGHER")
        self.assertEqual(by_name["parsed_lines"]["verdict"], "within noise")
        svg = pv.render_bench_svg("Compare", rows, "base", "cand")
        self.assertIn("30000 -&gt; 30000", svg)
        self.assertNotIn("30000.00s", svg)

    def test_single_package_mermaid_falls_back_to_module_edges(self):
        pkg = self.repo / "src" / "singlepkg"
        pkg.mkdir(parents=True)
        (pkg / "__init__.py").write_text("", encoding="utf-8")
        (pkg / "a.py").write_text("from singlepkg import b\n", encoding="utf-8")
        (pkg / "b.py").write_text("x = 1\n", encoding="utf-8")
        out = subprocess.run(
            [sys.executable, str(SCRIPTS / "arch_facts.py"), "--root", str(self.repo), "mermaid", "--view", "packages"],
            capture_output=True, text=True, encoding="utf-8", check=True,
        ).stdout
        self.assertIn("singlepkg.a", out)
        self.assertIn("singlepkg.b", out)


if __name__ == "__main__":
    unittest.main()
