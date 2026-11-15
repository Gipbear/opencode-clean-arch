"""Statistics used by reports."""


def big_order_stats(items, limit):
    acc = 0.0
    n = 0
    for it in items:
        if it.amount > limit:
            acc += it.amount
            n += 1
    mean = acc / n if n else 0.0
    return {"sum": acc, "n": n, "mean": mean}
