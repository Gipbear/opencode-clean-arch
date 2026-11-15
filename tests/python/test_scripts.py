import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "skills" / "clean-arch" / "scripts"
FIXTURE = ROOT / "tests" / "fixtures" / "sample_repo"


def run(script: str, repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPTS / script), "--root", str(repo), *args],
                          capture_output=True, text=True, timeout=120)


class FixtureRepo(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        shutil.copytree(FIXTURE, self.repo)

    def tearDown(self):
        shutil.rmtree(self.tmp)

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
            '  jobs["shop/jobs.py"] -.->|subprocess| rep["shop.services.report"]\n  user([用户]) --> jobs\n')
        self.assertEqual(run("arch_facts.py", self.repo, "verify", "docs/ok.mmd").returncode, 0)
        (docs / "plan.md").write_text(
            "# Plan\n\n```mermaid\nflowchart LR\n  m[\"shop.core.models\"] --> p[\"shop.core.pricing\"]\n"
            "  g[\"shop.ghost\"] --> m\n```\n\n```mermaid\nclassDiagram\n  class Ghost\n"
            "  Dispatcher <|-- EmailChannel\n```\n")
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


if __name__ == "__main__":
    unittest.main()
