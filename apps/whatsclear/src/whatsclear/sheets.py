from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

from .models import ShipmentRecord

MASTER_COLUMNS = [
    "Created Date",
    "Shipment #",
    "Customer",
    "Shipper",
    "Consignee",
    "Lane",
    "Invoice #",
    "BOL #",
    "PO #",
    "MX Carrier",
    "US Carrier",
    "Status",
    "Blocked Reason",
    "Owner",
    "Pickup Date",
    "ETA",
    "Pickup Appt",
    "Cross Date",
    "Delivery Date",
    "Delivery Appt",
    "Last Update",
    "Source",
    "Comments",
    "Manual Verification",
]


def shipment_to_row(shipment: ShipmentRecord) -> list[str]:
    return [
        shipment.created_date or "",
        shipment.shipment_number or "",
        shipment.customer or "",
        shipment.shipper or "",
        shipment.consignee or "",
        shipment.lane or "",
        shipment.invoice_number or "",
        shipment.bol_number or "",
        shipment.po_number or "",
        shipment.mx_carrier or "",
        shipment.us_carrier or "",
        shipment.status or "",
        shipment.blocked_reason or "",
        shipment.owner or "",
        shipment.pickup_date or "",
        shipment.eta or "",
        shipment.pickup_appt or "",
        shipment.cross_date or "",
        shipment.delivery_date or "",
        shipment.delivery_appt or "",
        shipment.last_update or "",
        shipment.source or "",
        shipment.comments or "",
        "TRUE" if shipment.manual_verification_required else "FALSE",
    ]


class LocalSheetSync:
    """
    Local fallback that writes a CSV-like TSV file while preserving manual edits by key.
    """

    def __init__(self, output_path: str | Path = "master_sheet.tsv") -> None:
        self.output_path = Path(output_path)

    def sync_shipments(self, shipments: list[ShipmentRecord]) -> None:
        existing_manual: dict[int, tuple[str, str, str]] = {}
        if self.output_path.exists():
            lines = self.output_path.read_text(encoding="utf-8").splitlines()
            for idx, line in enumerate(lines[1:], start=1):
                parts = line.split("\t")
                if len(parts) < len(MASTER_COLUMNS):
                    continue
                existing_manual[idx] = (parts[1], parts[13], parts[22])

        rows = ["\t".join(MASTER_COLUMNS)]
        for idx, shipment in enumerate(shipments, start=1):
            row = shipment_to_row(shipment)
            if idx in existing_manual:
                old_shipment_num, old_owner, old_comments = existing_manual[idx]
                row[1] = old_shipment_num or row[1]
                row[13] = old_owner or row[13]
                row[22] = old_comments or row[22]
            rows.append("\t".join(row))
        self.output_path.write_text("\n".join(rows) + "\n", encoding="utf-8")

    def row_dict(self, shipment: ShipmentRecord) -> dict[str, str]:
        row = shipment_to_row(shipment)
        return dict(zip(MASTER_COLUMNS, row, strict=True))


class GoogleSheetSync:
    """
    Optional sync adapter (requires `pip install .[google]` and service account credentials).
    """

    def __init__(self, spreadsheet_id: str, worksheet_name: str = "Master") -> None:
        self.spreadsheet_id = spreadsheet_id
        self.worksheet_name = worksheet_name

    def sync_shipments(self, shipments: list[ShipmentRecord]) -> None:
        from google.oauth2.service_account import Credentials
        from googleapiclient.discovery import build

        creds = Credentials.from_service_account_file(
            "service_account.json",
            scopes=["https://www.googleapis.com/auth/spreadsheets"],
        )
        service = build("sheets", "v4", credentials=creds)
        values = [MASTER_COLUMNS] + [shipment_to_row(s) for s in shipments]
        service.spreadsheets().values().update(
            spreadsheetId=self.spreadsheet_id,
            range=f"{self.worksheet_name}!A1",
            valueInputOption="RAW",
            body={"values": values},
        ).execute()
        self._apply_manual_verification_format(service, len(values))

    @staticmethod
    def to_payload(shipment: ShipmentRecord) -> dict[str, str]:
        return asdict(shipment)

    def _apply_manual_verification_format(self, service, row_count: int) -> None:
        # Highlights rows requiring manual verification in yellow (#FFF2CC).
        req = {
            "requests": [
                {
                    "addConditionalFormatRule": {
                        "rule": {
                            "ranges": [
                                {
                                    "sheetId": 0,
                                    "startRowIndex": 1,
                                    "endRowIndex": max(2, row_count),
                                    "startColumnIndex": 0,
                                    "endColumnIndex": len(MASTER_COLUMNS),
                                }
                            ],
                            "booleanRule": {
                                    "condition": {
                                        "type": "CUSTOM_FORMULA",
                                        "values": [{"userEnteredValue": "=$X2=\"TRUE\""}],
                                    },
                                "format": {
                                    "backgroundColor": {
                                        "red": 1.0,
                                        "green": 0.949,
                                        "blue": 0.8,
                                    }
                                },
                            },
                        },
                        "index": 0,
                    }
                }
            ]
        }
        service.spreadsheets().batchUpdate(
            spreadsheetId=self.spreadsheet_id,
            body=req,
        ).execute()
