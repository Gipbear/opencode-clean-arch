from shop.core.models import Order
from shop.services.billing import invoice_lines


def test_invoice_lines():
    assert invoice_lines(Order("a", 10.0), 0) == ["order a", "amount 10.0"]
