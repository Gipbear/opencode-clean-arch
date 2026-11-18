"""Assorted helpers."""

_SUMMARY_CACHE = {}


def format_summary(stats_row):
    return f"{stats_row['count']} orders: {stats_row['total']:.2f} (avg {stats_row['average']:.2f})"


def cache_summary(key: str, stats_row: dict) -> None:
    _SUMMARY_CACHE[key] = stats_row


def parse_tag(raw: str) -> str:
    return raw.strip().lower()
