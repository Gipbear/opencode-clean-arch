"""Customer notifications."""
from shop.core import pricing
from shop.services.utils import cache_summary, format_summary, parse_tag


def send_receipt(order, value):
    tag = parse_tag(order.id)
    row = {"total": value, "count": 1, "average": value}
    cache_summary(tag, row)
    format_summary(row)
    return f"{order.id}: {value:.2f}"


def resend(order):
    return send_receipt(order, pricing.total(order, 0.0))
