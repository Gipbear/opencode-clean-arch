"""Order domain objects."""
from dataclasses import dataclass


@dataclass
class Order:
    id: str
    amount: float
