"""Price calculation."""
from shop.core.models import Order
from shop.services.notify import send_receipt


def total(order: Order, tax: float) -> float:
    value = order.amount * (1 + tax)
    send_receipt(order, value)
    return value
