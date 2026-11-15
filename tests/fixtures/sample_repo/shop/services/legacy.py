"""Old entry points."""
from shop.core.models import Order

try:
    from shop.services.old_helpers import format_money
except ImportError:
    format_money = str

LegacyOrder = Order
