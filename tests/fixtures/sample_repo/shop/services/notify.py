"""Customer notifications."""
from shop.core import pricing


def send_receipt(order, value):
    return f"{order.id}: {value:.2f}"


def resend(order):
    return send_receipt(order, pricing.total(order, 0.0))
