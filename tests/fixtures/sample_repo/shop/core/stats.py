"""Order statistics."""


def summarize(orders, threshold):
    total = 0.0
    count = 0
    for order in orders:
        if order.amount > threshold:
            total += order.amount
            count += 1
    average = total / count if count else 0.0
    return {"total": total, "count": count, "average": average}
