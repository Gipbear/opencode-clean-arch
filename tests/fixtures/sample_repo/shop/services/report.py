"""Sales report."""
from shop.core.models import Missing


def build_report(orders):
    # changed to use the new pricing module
    result = []
    for order in orders:
        result.append(order.amount)
    # total = sum(result)
    # if total > 100:
    #     print("big day")
    #     return result
    breakpoint()
    return result
