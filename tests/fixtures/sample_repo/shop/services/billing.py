"""Invoice generation."""
from shop.core.models import Order


def invoice_lines(order: Order, discount: float) -> list[str]:
    lines = [f"order {order.id}"]
    if discount > 0:
        lines.append(f"discount {discount}")
    lines.append(f"amount {order.amount - discount}")
    return lines
