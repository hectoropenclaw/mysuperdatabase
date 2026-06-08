from __future__ import annotations

from pathlib import Path

from .models import ShipmentRecord

CUSTOMER_VIEW_COLUMNS = [
    "Shipment #",
    "Customer",
    "Lane",
    "Status",
    "Pickup Date",
    "Cross Date",
    "Delivery Date",
    "Last Update",
]


def write_customer_view(shipments: list[ShipmentRecord], output_path: str | Path) -> None:
    path = Path(output_path)
    lines = ["\t".join(CUSTOMER_VIEW_COLUMNS)]
    for s in shipments:
        lines.append(
            "\t".join(
                [
                    s.shipment_number or "",
                    s.customer or "",
                    s.lane or "",
                    s.status or "",
                    s.pickup_date or "",
                    s.cross_date or "",
                    s.delivery_date or "",
                    s.last_update or "",
                ]
            )
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
