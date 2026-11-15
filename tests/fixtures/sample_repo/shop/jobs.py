"""Batch jobs."""
import subprocess
import sys


def run_nightly():
    subprocess.run([sys.executable, "-m", "shop.services.report"], check=True)
