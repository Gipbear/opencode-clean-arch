"""Receipt output formats selected by --fmt."""


def render_v1(order):
    return order.id


def render_v2(order):
    return f"{order.id}:{order.amount}"


def render_v3(order):
    return {"id": order.id, "amount": order.amount}


def render(order, fmt):
    return {"v1": render_v1, "v2": render_v2, "v3": render_v3}[fmt](order)
