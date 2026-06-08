from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .pipeline import WhatsClearPipeline
from .repository import Repository
from .sheets import LocalSheetSync
from .views import write_customer_view


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="WhatsClear MVP CLI")
    parser.add_argument(
        "--db-path",
        default=os.getenv("WHATSCLEAR_DATABASE_URL") or "whatsclear.db",
        help="SQLite path or Supabase/Postgres database URL",
    )
    parser.add_argument("--sheet-path", default="master_sheet.tsv", help="Local sheet output path")

    sub = parser.add_subparsers(dest="command", required=True)

    ingest = sub.add_parser("ingest", help="Ingest one or more email payloads from JSON")
    ingest.add_argument("--email-json", required=True, help="Path to JSON file with email payload(s)")

    ingest_gmail = sub.add_parser("ingest-gmail", help="Poll Gmail and ingest recent messages")
    ingest_gmail.add_argument("--max-results", type=int, default=20)
    ingest_gmail.add_argument("--query", default="newer_than:2d")

    vocab = sub.add_parser("vocab-add", help="Add/update classification vocabulary mapping")
    vocab.add_argument("--phrase", required=True)
    vocab.add_argument("--mapped-status", required=True)
    vocab.add_argument("--language", default="en")

    sub.add_parser("list-shipments", help="Print shipment rows")

    override = sub.add_parser("override", help="Manual override for a shipment field")
    override.add_argument("--shipment-id", type=int, required=True)
    override.add_argument("--field", required=True)
    override.add_argument("--value", required=True)
    override.add_argument("--actor", default="manual-user")

    customer_view = sub.add_parser("customer-view", help="Generate customer-facing TSV")
    customer_view.add_argument("--output", default="customer_view.tsv")

    sub.add_parser("kpi", help="Print basic KPI snapshot")
    return parser


def _read_payloads(path: str) -> list[dict]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        return [raw]
    if isinstance(raw, list):
        return raw
    raise ValueError("Email JSON must be an object or array.")


def cmd_ingest(args: argparse.Namespace) -> int:
    repo = Repository(args.db_path)
    sync = LocalSheetSync(args.sheet_path)
    pipeline = WhatsClearPipeline(repository=repo, sheet_sync=sync)
    payloads = _read_payloads(args.email_json)
    for payload in payloads:
        message = pipeline.from_payload(payload)
        shipment, flags = pipeline.process_message(message)
        reasons = ", ".join(f.reason for f in flags) if flags else "none"
        print(f"shipment_id={shipment.id} status={shipment.status} flags={reasons}")
    pipeline.close()
    return 0


def cmd_ingest_gmail(args: argparse.Namespace) -> int:
    from .gmail_adapter import GmailAdapter

    repo = Repository(args.db_path)
    sync = LocalSheetSync(args.sheet_path)
    pipeline = WhatsClearPipeline(repository=repo, sheet_sync=sync)
    adapter = GmailAdapter()
    messages = adapter.list_recent_messages(max_results=args.max_results, query=args.query)
    for message in messages:
        shipment, flags = pipeline.process_message(message)
        reasons = ", ".join(f.reason for f in flags) if flags else "none"
        print(f"shipment_id={shipment.id} status={shipment.status} flags={reasons}")
    pipeline.close()
    return 0


def cmd_vocab_add(args: argparse.Namespace) -> int:
    repo = Repository(args.db_path)
    repo.upsert_vocabulary(args.phrase, args.mapped_status, args.language)
    repo.close()
    print("Vocabulary updated.")
    return 0


def cmd_list_shipments(args: argparse.Namespace) -> int:
    repo = Repository(args.db_path)
    for shipment in repo.list_shipments():
        print(
            f"id={shipment.id} shipment#={shipment.shipment_number or ''} status={shipment.status or ''} "
            f"manual={shipment.manual_verification_required}"
        )
    repo.close()
    return 0


def cmd_override(args: argparse.Namespace) -> int:
    repo = Repository(args.db_path)
    shipment = repo.update_shipment_fields(
        shipment_id=args.shipment_id,
        updates={args.field: args.value, "manual_verification_required": True},
        actor=args.actor,
        preserve_manual_fields=False,
    )
    repo.close()
    print(f"Updated shipment id={shipment.id} field={args.field}")
    return 0


def cmd_customer_view(args: argparse.Namespace) -> int:
    repo = Repository(args.db_path)
    shipments = repo.list_shipments()
    write_customer_view(shipments, args.output)
    repo.close()
    print(f"Wrote {args.output}")
    return 0


def cmd_kpi(args: argparse.Namespace) -> int:
    repo = Repository(args.db_path)
    metrics = repo.get_metrics_snapshot()
    repo.close()
    for key, value in metrics.items():
        print(f"{key}={value:.4f}")
    return 0


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "ingest":
        raise SystemExit(cmd_ingest(args))
    if args.command == "ingest-gmail":
        raise SystemExit(cmd_ingest_gmail(args))
    if args.command == "vocab-add":
        raise SystemExit(cmd_vocab_add(args))
    if args.command == "list-shipments":
        raise SystemExit(cmd_list_shipments(args))
    if args.command == "override":
        raise SystemExit(cmd_override(args))
    if args.command == "customer-view":
        raise SystemExit(cmd_customer_view(args))
    if args.command == "kpi":
        raise SystemExit(cmd_kpi(args))
    raise SystemExit(2)
