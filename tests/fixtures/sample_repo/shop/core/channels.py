"""Delivery channels for notifications."""
from abc import ABC, abstractmethod

from shop.core.models import Order


class Channel(ABC):
    @abstractmethod
    def deliver(self, order: Order, text: str) -> str: ...


class EmailChannel(Channel):
    def deliver(self, order, text):
        return f"mail {order.id}: {text}"


class Dispatcher:
    def __init__(self, channel: Channel):
        self.channel = channel

    def dispatch(self, order: Order, text: str) -> str:
        return self.channel.deliver(order, text)


class _Scratch:
    pass
