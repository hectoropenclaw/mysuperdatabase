from __future__ import annotations

import json
import os
import re
import sqlite3
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import AttachmentExtraction, EmailMessage, ShipmentRecord


def utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _looks_like_postgres_url(value: str) -> bool:
    return value.startswith(("postgres://", "postgresql://"))


def _qmark_to_psycopg(sql: str) -> str:
    return sql.replace("?", "%s")


class PostgresConnection:
    def __init__(self, database_url: str) -> None:
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:
            raise RuntimeError(
                "Postgres/Supabase support requires psycopg. "
                "Install with: python -m pip install -e .[postgres]"
            ) from exc

        self._conn = psycopg.connect(database_url, row_factory=dict_row)

    def cursor(self) -> Any:
        return PostgresCursor(self._conn.cursor())

    def execute(self, sql: str, params: Any = None) -> Any:
        return self._conn.execute(_qmark_to_psycopg(sql), params)

    def executescript(self, script: str) -> None:
        with self._conn.cursor() as cursor:
            for statement in script.split(";"):
                sql = statement.strip()
                if sql:
                    cursor.execute(sql)

    def commit(self) -> None:
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()


class PostgresCursor:
    def __init__(self, cursor: Any) -> None:
        self._cursor = cursor

    def execute(self, sql: str, params: Any = None) -> Any:
        self._cursor.execute(_qmark_to_psycopg(sql), params)
        return self

    def executescript(self, script: str) -> None:
        for statement in script.split(";"):
            sql = statement.strip()
            if sql:
                self._cursor.execute(sql)

    def fetchone(self) -> Any:
        return self._cursor.fetchone()

    def fetchall(self) -> Any:
        return self._cursor.fetchall()


DEFAULT_SETTINGS: dict[str, Any] = {
    "default_owner_rules": [],
    "classification_confidence_low": 0.5,
    "classification_confidence_high": 0.8,
    "sync_mode": "auto",
    "polling_interval": 60,
    "semantic_extraction": {
        "enabled": False,
        "provider": "openai",
        "model": "gpt-4.1-mini",
        "endpoint": "",
        "timeout_seconds": 20,
        "max_retries": 2,
        "api_key_configured": False,
    },
    "schema_validation": {
        "enabled": True,
        "schema_name": "shipment_event_v1",
        "auto_apply_threshold": 0.9,
        "review_threshold": 0.65,
        "require_source_evidence": True,
        "allow_forward_status_jumps": True,
        "conservative_status_mode": True,
        "allowed_statuses": [
            "Shipment Requested",
            "Pickup Scheduled",
            "Pickup Completed",
            "Docs Missing",
            "Docs Sent",
            "Export Cleared",
            "Import Cleared",
            "Filed",
            "Released",
            "Crossed",
            "Dispatch Pending",
            "Dispatched",
            "Delivered",
        ],
        "required_fields": [
            "status",
            "confidence",
            "source_evidence",
        ],
    },
    "source_trust_policy": {
        "trusted_domains": [],
        "trusted_channels": [],
        "prefer_pdf_over_email_body": True,
        "allow_freeform_email_auto_apply": False,
    },
}


class Repository:
    def __init__(self, db_path: str | Path | None = None) -> None:
        self.db_path = str(db_path or os.getenv("WHATSCLEAR_DATABASE_URL") or "whatsclear.db")
        self.backend = "postgres" if _looks_like_postgres_url(self.db_path) else "sqlite"
        if self.backend == "postgres":
            self.conn = PostgresConnection(self.db_path)
        else:
            self.conn = sqlite3.connect(self.db_path)
            self.conn.row_factory = sqlite3.Row
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        if self.backend == "postgres":
            self._ensure_postgres_schema()
            return

        cursor = self.conn.cursor()
        cursor.executescript(
            """
            CREATE TABLE IF NOT EXISTS shipments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                shipment_number TEXT,
                customer TEXT,
                shipper TEXT,
                consignee TEXT,
                lane TEXT,
                invoice_number TEXT,
                bol_number TEXT,
                po_number TEXT,
                mx_carrier TEXT,
                us_carrier TEXT,
                status TEXT,
                blocked_reason TEXT,
                pickup_date TEXT,
                eta TEXT,
                pickup_appt TEXT,
                cross_date TEXT,
                delivery_date TEXT,
                delivery_appt TEXT,
                created_date TEXT NOT NULL,
                last_update TEXT NOT NULL,
                owner TEXT,
                source TEXT,
                comments TEXT,
                manual_verification_required INTEGER NOT NULL DEFAULT 0,
                lifecycle_state TEXT NOT NULL DEFAULT 'active',
                closed_at TEXT,
                closed_reason TEXT,
                auto_closed INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS messages (
                message_id TEXT PRIMARY KEY,
                shipment_id INTEGER,
                thread_id TEXT,
                raw_text TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                classification TEXT,
                confidence_score REAL NOT NULL,
                FOREIGN KEY (shipment_id) REFERENCES shipments(id)
            );

            CREATE TABLE IF NOT EXISTS attachments (
                attachment_id TEXT PRIMARY KEY,
                shipment_id INTEGER,
                filename TEXT NOT NULL,
                storage_url TEXT,
                extracted_data TEXT NOT NULL,
                is_digital_pdf INTEGER NOT NULL,
                FOREIGN KEY (shipment_id) REFERENCES shipments(id)
            );

            CREATE TABLE IF NOT EXISTS vocabulary_mapping (
                phrase TEXT PRIMARY KEY,
                language TEXT NOT NULL DEFAULT 'en',
                mapped_status TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                shipment_id INTEGER,
                field TEXT NOT NULL,
                old_value TEXT,
                new_value TEXT,
                actor TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS intake_channels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_name TEXT NOT NULL,
                provider_type TEXT NOT NULL,
                auth_data TEXT,
                sync_mode TEXT NOT NULL,
                polling_interval INTEGER NOT NULL DEFAULT 60,
                folder_label TEXT,
                active INTEGER NOT NULL DEFAULT 0,
                last_successful_sync TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS intake_errors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id INTEGER,
                timestamp TEXT NOT NULL,
                provider_message_id TEXT,
                error_type TEXT NOT NULL,
                error_details TEXT,
                retry_status TEXT NOT NULL DEFAULT 'pending',
                ignored_reason TEXT,
                FOREIGN KEY (channel_id) REFERENCES intake_channels(id)
            );

            CREATE TABLE IF NOT EXISTS extraction_audits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                shipment_id INTEGER,
                message_id TEXT,
                provider_name TEXT,
                model_name TEXT,
                schema_name TEXT,
                decision TEXT NOT NULL,
                confidence_score REAL,
                action_taken TEXT,
                payload_json TEXT NOT NULL,
                validation_errors_json TEXT,
                source_evidence_json TEXT,
                review_notes TEXT,
                FOREIGN KEY (shipment_id) REFERENCES shipments(id),
                FOREIGN KEY (message_id) REFERENCES messages(message_id)
            );
            """
        )
        self._ensure_column("messages", "thread_id", "TEXT")
        self._ensure_column("shipments", "eta", "TEXT")
        self.conn.commit()

    def _ensure_postgres_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS shipments (
                id BIGSERIAL PRIMARY KEY,
                shipment_number TEXT,
                customer TEXT,
                shipper TEXT,
                consignee TEXT,
                lane TEXT,
                invoice_number TEXT,
                bol_number TEXT,
                po_number TEXT,
                mx_carrier TEXT,
                us_carrier TEXT,
                status TEXT,
                blocked_reason TEXT,
                pickup_date TEXT,
                eta TEXT,
                pickup_appt TEXT,
                cross_date TEXT,
                delivery_date TEXT,
                delivery_appt TEXT,
                created_date TEXT NOT NULL,
                last_update TEXT NOT NULL,
                owner TEXT,
                source TEXT,
                comments TEXT,
                manual_verification_required INTEGER NOT NULL DEFAULT 0,
                lifecycle_state TEXT NOT NULL DEFAULT 'active',
                closed_at TEXT,
                closed_reason TEXT,
                auto_closed INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS messages (
                message_id TEXT PRIMARY KEY,
                shipment_id BIGINT REFERENCES shipments(id),
                thread_id TEXT,
                raw_text TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                classification TEXT,
                confidence_score DOUBLE PRECISION NOT NULL
            );

            CREATE TABLE IF NOT EXISTS attachments (
                attachment_id TEXT PRIMARY KEY,
                shipment_id BIGINT REFERENCES shipments(id),
                filename TEXT NOT NULL,
                storage_url TEXT,
                extracted_data TEXT NOT NULL,
                is_digital_pdf INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS vocabulary_mapping (
                phrase TEXT PRIMARY KEY,
                language TEXT NOT NULL DEFAULT 'en',
                mapped_status TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS audit_log (
                id BIGSERIAL PRIMARY KEY,
                timestamp TEXT NOT NULL,
                shipment_id BIGINT,
                field TEXT NOT NULL,
                old_value TEXT,
                new_value TEXT,
                actor TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS intake_channels (
                id BIGSERIAL PRIMARY KEY,
                channel_name TEXT NOT NULL,
                provider_type TEXT NOT NULL,
                auth_data TEXT,
                sync_mode TEXT NOT NULL,
                polling_interval INTEGER NOT NULL DEFAULT 60,
                folder_label TEXT,
                active INTEGER NOT NULL DEFAULT 0,
                last_successful_sync TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS intake_errors (
                id BIGSERIAL PRIMARY KEY,
                channel_id BIGINT REFERENCES intake_channels(id),
                timestamp TEXT NOT NULL,
                provider_message_id TEXT,
                error_type TEXT NOT NULL,
                error_details TEXT,
                retry_status TEXT NOT NULL DEFAULT 'pending',
                ignored_reason TEXT
            );

            CREATE TABLE IF NOT EXISTS extraction_audits (
                id BIGSERIAL PRIMARY KEY,
                timestamp TEXT NOT NULL,
                shipment_id BIGINT REFERENCES shipments(id),
                message_id TEXT REFERENCES messages(message_id),
                provider_name TEXT,
                model_name TEXT,
                schema_name TEXT,
                decision TEXT NOT NULL,
                confidence_score DOUBLE PRECISION,
                action_taken TEXT,
                payload_json TEXT NOT NULL,
                validation_errors_json TEXT,
                source_evidence_json TEXT,
                review_notes TEXT
            );
            """
        )
        self.conn.commit()

    def _ensure_column(self, table: str, column: str, definition: str) -> None:
        if self.backend == "postgres":
            row = self.conn.execute(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = ? AND column_name = ?
                """,
                (table, column),
            ).fetchone()
            if row:
                return
            self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            return

        cols = self.conn.execute(f"PRAGMA table_info({table})").fetchall()
        if any(row["name"] == column for row in cols):
            return
        self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def close(self) -> None:
        self.conn.close()

    def _insert_and_get_id(self, sql: str, params: Any) -> int:
        if self.backend == "postgres":
            row = self.conn.execute(f"{sql} RETURNING id", params).fetchone()
            assert row is not None
            return int(row["id"])

        cursor = self.conn.cursor()
        cursor.execute(sql, params)
        assert cursor.lastrowid is not None
        return int(cursor.lastrowid)

    def get_active_vocabulary(self) -> dict[str, str]:
        cursor = self.conn.cursor()
        rows = cursor.execute(
            "SELECT phrase, mapped_status FROM vocabulary_mapping WHERE active = 1"
        ).fetchall()
        return {row["phrase"]: row["mapped_status"] for row in rows}

    def upsert_vocabulary(self, phrase: str, mapped_status: str, language: str = "en") -> None:
        cursor = self.conn.cursor()
        cursor.execute(
            """
            INSERT INTO vocabulary_mapping(phrase, language, mapped_status, active)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(phrase) DO UPDATE SET
                language = excluded.language,
                mapped_status = excluded.mapped_status,
                active = 1
            """,
            (phrase.lower(), language, mapped_status),
        )
        self._ensure_column("shipments", "lifecycle_state", "TEXT NOT NULL DEFAULT 'active'")
        self._ensure_column("shipments", "closed_at", "TEXT")
        self._ensure_column("shipments", "closed_reason", "TEXT")
        self._ensure_column("shipments", "auto_closed", "INTEGER NOT NULL DEFAULT 0")
        self.conn.commit()

    def _ensure_column(self, table: str, column: str, ddl: str) -> None:
        if self.backend == "postgres":
            row = self.conn.execute(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = ? AND column_name = ?
                """,
                (table, column),
            ).fetchone()
            if row:
                return
            self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
            return

        columns = {
            row["name"]
            for row in self.conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        if column not in columns:
            self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")

    def _row_to_shipment(self, row: sqlite3.Row) -> ShipmentRecord:
        return ShipmentRecord(
            id=row["id"],
            shipment_number=row["shipment_number"],
            customer=row["customer"],
            shipper=row["shipper"],
            consignee=row["consignee"],
            lane=row["lane"],
            invoice_number=row["invoice_number"],
            bol_number=row["bol_number"],
            po_number=row["po_number"],
            mx_carrier=row["mx_carrier"],
            us_carrier=row["us_carrier"],
            status=row["status"],
            blocked_reason=row["blocked_reason"],
            pickup_date=row["pickup_date"],
            eta=row["eta"],
            pickup_appt=row["pickup_appt"],
            cross_date=row["cross_date"],
            delivery_date=row["delivery_date"],
            delivery_appt=row["delivery_appt"],
            created_date=row["created_date"],
            last_update=row["last_update"],
            owner=row["owner"],
            source=row["source"],
            comments=row["comments"],
            manual_verification_required=bool(row["manual_verification_required"]),
            lifecycle_state=row["lifecycle_state"] or "active",
            closed_at=row["closed_at"],
            closed_reason=row["closed_reason"],
            auto_closed=bool(row["auto_closed"]),
        )

    def get_shipment_by_number(self, shipment_number: str) -> ShipmentRecord | None:
        row = self.conn.execute(
            "SELECT * FROM shipments WHERE shipment_number = ?",
            (shipment_number,),
        ).fetchone()
        return self._row_to_shipment(row) if row else None

    def find_shipment_by_doc_refs(
        self,
        invoice_number: str | None,
        bol_number: str | None,
        po_number: str | None,
    ) -> list[ShipmentRecord]:
        clauses = []
        values: list[str] = []
        if invoice_number:
            clauses.append("invoice_number = ?")
            values.append(invoice_number)
        if bol_number:
            clauses.append("bol_number = ?")
            values.append(bol_number)
        if po_number:
            clauses.append("po_number = ?")
            values.append(po_number)
        if not clauses:
            return []

        query = f"SELECT * FROM shipments WHERE {' OR '.join(clauses)}"
        rows = self.conn.execute(query, values).fetchall()
        return [self._row_to_shipment(row) for row in rows]

    def create_shipment(self, payload: dict[str, Any], actor: str = "system") -> ShipmentRecord:
        # Idempotency guard: if a shipment with the same document refs already exists,
        # reuse the most recently updated one instead of creating a duplicate row.
        doc_invoice = payload.get("invoice_number")
        doc_bol = payload.get("bol_number")
        doc_po = payload.get("po_number")
        if doc_invoice or doc_bol or doc_po:
            candidates = self.find_shipment_by_doc_refs(doc_invoice, doc_bol, doc_po)
            if candidates:
                return sorted(candidates, key=lambda s: (s.last_update, s.id), reverse=True)[0]

        now = utc_now()
        fields = {
            "shipment_number": payload.get("shipment_number"),
            "customer": payload.get("customer"),
            "shipper": payload.get("shipper"),
            "consignee": payload.get("consignee"),
            "lane": payload.get("lane"),
            "invoice_number": payload.get("invoice_number"),
            "bol_number": payload.get("bol_number"),
            "po_number": payload.get("po_number"),
            "mx_carrier": payload.get("mx_carrier"),
            "us_carrier": payload.get("us_carrier"),
            "status": payload.get("status"),
            "blocked_reason": payload.get("blocked_reason"),
            "pickup_date": payload.get("pickup_date"),
            "eta": payload.get("eta"),
            "pickup_appt": payload.get("pickup_appt"),
            "cross_date": payload.get("cross_date"),
            "delivery_date": payload.get("delivery_date"),
            "delivery_appt": payload.get("delivery_appt"),
            "created_date": now,
            "last_update": now,
            "owner": payload.get("owner"),
            "source": payload.get("source", "email+pdf"),
            "comments": payload.get("comments"),
            "manual_verification_required": int(bool(payload.get("manual_verification_required"))),
            "lifecycle_state": payload.get("lifecycle_state", "active"),
            "closed_at": payload.get("closed_at"),
            "closed_reason": payload.get("closed_reason"),
            "auto_closed": int(bool(payload.get("auto_closed"))),
        }
        cols = ",".join(fields.keys())
        placeholders = ",".join(["?"] * len(fields))
        shipment_id = self._insert_and_get_id(
            f"INSERT INTO shipments ({cols}) VALUES ({placeholders})",
            list(fields.values()),
        )
        self.conn.commit()
        shipment = self.get_shipment_by_id(shipment_id)
        assert shipment is not None
        self.log_audit(shipment_id, "create", None, json.dumps(asdict(shipment)), actor)
        return shipment

    def get_shipment_by_id(self, shipment_id: int) -> ShipmentRecord | None:
        row = self.conn.execute(
            "SELECT * FROM shipments WHERE id = ?",
            (shipment_id,),
        ).fetchone()
        return self._row_to_shipment(row) if row else None

    def update_shipment_fields(
        self,
        shipment_id: int,
        updates: dict[str, Any],
        actor: str = "system",
        preserve_manual_fields: bool = True,
    ) -> ShipmentRecord:
        current = self.get_shipment_by_id(shipment_id)
        if not current:
            raise ValueError(f"Shipment id={shipment_id} does not exist")

        protected_fields = {"owner", "comments", "shipment_number"} if preserve_manual_fields else set()

        cursor = self.conn.cursor()
        for field, new_value in updates.items():
            if field in protected_fields and getattr(current, field) not in (None, ""):
                continue
            old_value = getattr(current, field)
            if old_value == new_value:
                continue
            cursor.execute(
                f"UPDATE shipments SET {field} = ?, last_update = ? WHERE id = ?",
                (new_value, utc_now(), shipment_id),
            )
            self.log_audit(shipment_id, field, str(old_value) if old_value is not None else None, str(new_value), actor)

        resulting_status = updates.get("status", current.status)
        if resulting_status == "Delivered":
            if updates.get("lifecycle_state") is None:
                cursor.execute(
                    "UPDATE shipments SET lifecycle_state = ?, closed_at = NULL, closed_reason = NULL, auto_closed = 0, last_update = ? WHERE id = ?",
                    ("active", utc_now(), shipment_id),
                )
        elif resulting_status and current.lifecycle_state == "closed":
            cursor.execute(
                "UPDATE shipments SET lifecycle_state = ?, closed_at = NULL, closed_reason = NULL, auto_closed = 0, last_update = ? WHERE id = ?",
                ("active", utc_now(), shipment_id),
            )
            self.log_audit(shipment_id, "lifecycle_state", "closed", "active", actor)

        self.conn.commit()
        shipment = self.get_shipment_by_id(shipment_id)
        assert shipment is not None
        return shipment

    def get_message_record(self, message_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            """
            SELECT message_id, shipment_id, thread_id, timestamp, classification, confidence_score
            FROM messages
            WHERE message_id = ?
            """,
            (message_id,),
        ).fetchone()
        if not row:
            return None
        return {
            "message_id": row["message_id"],
            "shipment_id": row["shipment_id"],
            "thread_id": row["thread_id"],
            "timestamp": row["timestamp"],
            "classification": row["classification"],
            "confidence_score": row["confidence_score"],
        }

    def get_recent_shipment_by_thread(self, thread_id: str | None) -> ShipmentRecord | None:
        if not thread_id:
            return None
        row = self.conn.execute(
            """
            SELECT shipment_id
            FROM messages
            WHERE thread_id = ?
            ORDER BY timestamp DESC
            LIMIT 1
            """,
            (thread_id,),
        ).fetchone()
        if not row or row["shipment_id"] is None:
            return None
        return self.get_shipment_by_id(int(row["shipment_id"]))

    def get_recent_shipment_by_message_reference(self, reference: str | None) -> ShipmentRecord | None:
        if not reference:
            return None
        tokens = re.findall(r"<[^>]+>", reference)
        if not tokens:
            tokens = [reference.strip()]
        tokens = [token for token in tokens if token]
        if not tokens:
            return None

        placeholders = ",".join(["?"] * len(tokens))
        row = self.conn.execute(
            f"""
            SELECT shipment_id
            FROM messages
            WHERE message_id IN ({placeholders}) OR thread_id IN ({placeholders})
            ORDER BY timestamp DESC
            LIMIT 1
            """,
            [*tokens, *tokens],
        ).fetchone()
        if not row or row["shipment_id"] is None:
            return None
        return self.get_shipment_by_id(int(row["shipment_id"]))

    def store_message(
        self,
        message: EmailMessage,
        shipment_id: int,
        classification: str | None,
        confidence: float,
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO messages(message_id, shipment_id, thread_id, raw_text, timestamp, classification, confidence_score)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(message_id) DO UPDATE SET
                shipment_id = excluded.shipment_id,
                thread_id = excluded.thread_id,
                raw_text = excluded.raw_text,
                timestamp = excluded.timestamp,
                classification = excluded.classification,
                confidence_score = excluded.confidence_score
            """,
            (
                message.message_id,
                shipment_id,
                message.thread_id,
                f"{message.subject}\n{message.body}",
                message.timestamp.isoformat(),
                classification,
                confidence,
            ),
        )
        self.conn.commit()

    def store_attachment(self, attachment: AttachmentExtraction, shipment_id: int) -> None:
        self.conn.execute(
            """
            INSERT INTO attachments(attachment_id, shipment_id, filename, storage_url, extracted_data, is_digital_pdf)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(attachment_id) DO UPDATE SET
                shipment_id = excluded.shipment_id,
                filename = excluded.filename,
                storage_url = excluded.storage_url,
                extracted_data = excluded.extracted_data,
                is_digital_pdf = excluded.is_digital_pdf
            """,
            (
                attachment.attachment_id,
                shipment_id,
                attachment.filename,
                attachment.storage_url,
                json.dumps(attachment.extracted_data),
                int(attachment.is_digital_pdf),
            ),
        )
        self.conn.commit()

    def merge_duplicate_shipments(self) -> int:
        """
        Merge duplicate shipment rows by operational identity keys.
        Keeps the most recently updated shipment and re-links related records.
        """
        rows = self.conn.execute(
            """
            SELECT id, invoice_number, bol_number, po_number, lane, customer, last_update
            FROM shipments
            ORDER BY last_update DESC, id DESC
            """
        ).fetchall()
        groups: dict[tuple[str, ...], list[int]] = {}
        for row in rows:
            invoice = (row["invoice_number"] or "").strip().upper()
            bol = (row["bol_number"] or "").strip().upper()
            po = (row["po_number"] or "").strip().upper()
            lane = (row["lane"] or "").strip().upper()
            customer = (row["customer"] or "").strip().upper()
            key: tuple[str, ...] | None = None
            if invoice:
                key = ("INV", invoice)
            elif bol:
                key = ("BOL", bol)
            elif po and lane and customer:
                key = ("PO", po, lane, customer)
            if not key:
                continue
            groups.setdefault(key, []).append(int(row["id"]))

        merged = 0
        for ids in groups.values():
            if len(ids) < 2:
                continue
            keep_id = ids[0]
            drop_ids = ids[1:]
            placeholders = ",".join(["?"] * len(drop_ids))
            self.conn.execute(
                f"UPDATE messages SET shipment_id = ? WHERE shipment_id IN ({placeholders})",
                [keep_id, *drop_ids],
            )
            self.conn.execute(
                f"UPDATE attachments SET shipment_id = ? WHERE shipment_id IN ({placeholders})",
                [keep_id, *drop_ids],
            )
            self.conn.execute(
                f"UPDATE audit_log SET shipment_id = ? WHERE shipment_id IN ({placeholders})",
                [keep_id, *drop_ids],
            )
            self.conn.execute(
                f"UPDATE extraction_audits SET shipment_id = ? WHERE shipment_id IN ({placeholders})",
                [keep_id, *drop_ids],
            )
            self.conn.execute(
                f"DELETE FROM shipments WHERE id IN ({placeholders})",
                drop_ids,
            )
            merged += len(drop_ids)
        if merged:
            self.conn.commit()
        return merged

    def log_audit(
        self,
        shipment_id: int,
        field: str,
        old_value: str | None,
        new_value: str | None,
        actor: str,
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO audit_log(timestamp, shipment_id, field, old_value, new_value, actor)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (utc_now(), shipment_id, field, old_value, new_value, actor),
        )
        self.conn.commit()

    def list_shipments(self) -> list[ShipmentRecord]:
        rows = self.conn.execute("SELECT * FROM shipments ORDER BY id ASC").fetchall()
        return [self._row_to_shipment(row) for row in rows]

    def auto_close_delivered_shipments(self, retention_days: int = 1, actor: str = "system") -> int:
        now = datetime.now(tz=timezone.utc)
        rows = self.conn.execute(
            """
            SELECT id, status, last_update, lifecycle_state
            FROM shipments
            WHERE status = 'Delivered' AND COALESCE(lifecycle_state, 'active') != 'closed'
            """
        ).fetchall()
        closed = 0
        for row in rows:
            try:
                delivered_marked_at = datetime.fromisoformat(row["last_update"])
            except ValueError:
                continue
            if delivered_marked_at.tzinfo is None:
                delivered_marked_at = delivered_marked_at.replace(tzinfo=timezone.utc)
            if (now - delivered_marked_at).total_seconds() < retention_days * 86400:
                continue
            closed_at = utc_now()
            self.conn.execute(
                """
                UPDATE shipments
                SET lifecycle_state = ?, closed_at = ?, closed_reason = ?, auto_closed = ?, last_update = ?
                WHERE id = ?
                """,
                ("closed", closed_at, "delivered", 1, closed_at, row["id"]),
            )
            self.log_audit(row["id"], "lifecycle_state", row["lifecycle_state"] or "active", "closed", actor)
            closed += 1
        if closed:
            self.conn.commit()
        return closed

    def query_shipments(
        self,
        q: str | None = None,
        status: str | None = None,
        lane: str | None = None,
        owner: str | None = None,
        blocked: bool | None = None,
        manual_verification: bool | None = None,
        include_closed: bool = False,
        sort_by: str = "last_update",
        sort_dir: str = "desc",
    ) -> list[ShipmentRecord]:
        self.auto_close_delivered_shipments(retention_days=1)
        clauses: list[str] = []
        params: list[Any] = []

        if q:
            pattern = f"%{q}%"
            clauses.append(
                "("
                "COALESCE(shipment_number, '') LIKE ? OR "
                "COALESCE(invoice_number, '') LIKE ? OR "
                "COALESCE(bol_number, '') LIKE ? OR "
                "COALESCE(po_number, '') LIKE ? OR "
                "COALESCE(eta, '') LIKE ? OR "
                "COALESCE(shipper, '') LIKE ? OR "
                "COALESCE(consignee, '') LIKE ?"
                ")"
            )
            params.extend([pattern, pattern, pattern, pattern, pattern, pattern, pattern])
        if status:
            clauses.append("status = ?")
            params.append(status)
        if lane:
            clauses.append("lane = ?")
            params.append(lane)
        if owner:
            clauses.append("owner = ?")
            params.append(owner)
        if blocked is not None:
            clauses.append(
                "CASE WHEN blocked_reason IS NULL OR blocked_reason = '' THEN 0 ELSE 1 END = ?"
            )
            params.append(int(blocked))
        if manual_verification is not None:
            clauses.append("manual_verification_required = ?")
            params.append(int(manual_verification))
        if not include_closed:
            clauses.append("COALESCE(lifecycle_state, 'active') = 'active'")

        where_clause = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        safe_sort_fields = {"id", "last_update", "status", "lane", "owner", "created_date"}
        safe_sort = sort_by if sort_by in safe_sort_fields else "last_update"
        safe_dir = "ASC" if sort_dir.lower() == "asc" else "DESC"
        query = f"SELECT * FROM shipments {where_clause} ORDER BY {safe_sort} {safe_dir}, id DESC"
        rows = self.conn.execute(query, params).fetchall()
        shipments = [self._row_to_shipment(row) for row in rows]
        return self._dedupe_shipments_for_dashboard(shipments)

    @staticmethod
    def _dedupe_shipments_for_dashboard(shipments: list[ShipmentRecord]) -> list[ShipmentRecord]:
        """
        Prevent duplicate rows in the operational dashboard by collapsing records that
        point to the same shipment identity keys.
        The input order is already sorted, so the first encountered row is kept.
        """
        kept: list[ShipmentRecord] = []
        seen: set[tuple[str, ...]] = set()
        for shipment in shipments:
            key: tuple[str, ...] | None = None
            invoice = (shipment.invoice_number or "").strip().upper()
            bol = (shipment.bol_number or "").strip().upper()
            po = (shipment.po_number or "").strip().upper()
            lane = (shipment.lane or "").strip().upper()
            customer = (shipment.customer or "").strip().upper()

            if invoice:
                key = ("INV", invoice)
            elif bol:
                key = ("BOL", bol)
            elif po and lane and customer:
                key = ("PO", po, lane, customer)

            if key and key in seen:
                continue
            if key:
                seen.add(key)
            kept.append(shipment)
        return kept

    def list_vocabulary(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT phrase, language, mapped_status, active FROM vocabulary_mapping ORDER BY phrase ASC"
        ).fetchall()
        return [
            {
                "phrase": row["phrase"],
                "language": row["language"],
                "mapped_status": row["mapped_status"],
                "active": bool(row["active"]),
            }
            for row in rows
        ]

    def patch_vocabulary(
        self,
        phrase: str,
        mapped_status: str | None = None,
        language: str | None = None,
        active: bool | None = None,
    ) -> dict[str, Any]:
        existing = self.conn.execute(
            "SELECT phrase, language, mapped_status, active FROM vocabulary_mapping WHERE phrase = ?",
            (phrase.lower(),),
        ).fetchone()
        if not existing:
            raise ValueError(f"Vocabulary phrase not found: {phrase}")

        new_language = language if language is not None else existing["language"]
        new_mapped_status = mapped_status if mapped_status is not None else existing["mapped_status"]
        new_active = int(active) if active is not None else existing["active"]
        self.conn.execute(
            """
            UPDATE vocabulary_mapping
            SET language = ?, mapped_status = ?, active = ?
            WHERE phrase = ?
            """,
            (new_language, new_mapped_status, new_active, phrase.lower()),
        )
        self.conn.commit()
        return {
            "phrase": phrase.lower(),
            "language": new_language,
            "mapped_status": new_mapped_status,
            "active": bool(new_active),
        }

    def list_audit_log(
        self,
        shipment_id: int | None = None,
        actor: str | None = None,
        field: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if shipment_id is not None:
            clauses.append("shipment_id = ?")
            params.append(shipment_id)
        if actor:
            clauses.append("actor = ?")
            params.append(actor)
        if field:
            clauses.append("field = ?")
            params.append(field)
        if date_from:
            clauses.append("timestamp >= ?")
            params.append(date_from)
        if date_to:
            clauses.append("timestamp <= ?")
            params.append(date_to)

        where_clause = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self.conn.execute(
            f"""
            SELECT id, timestamp, shipment_id, field, old_value, new_value, actor
            FROM audit_log
            {where_clause}
            ORDER BY timestamp DESC, id DESC
            """,
            params,
        ).fetchall()
        return [
            {
                "id": row["id"],
                "timestamp": row["timestamp"],
                "shipment_id": row["shipment_id"],
                "field": row["field"],
                "old_value": row["old_value"],
                "new_value": row["new_value"],
                "actor": row["actor"],
            }
            for row in rows
        ]

    def get_settings(self) -> dict[str, Any]:
        row = self.conn.execute(
            "SELECT value_json FROM app_settings WHERE key = 'global'"
        ).fetchone()
        if not row:
            default = json.loads(json.dumps(DEFAULT_SETTINGS))
            self.patch_settings(default)
            return default
        stored = json.loads(row["value_json"])
        return self._deep_merge_settings(json.loads(json.dumps(DEFAULT_SETTINGS)), stored)

    def patch_settings(self, updates: dict[str, Any]) -> dict[str, Any]:
        current = self.get_settings() if self.conn.execute(
            "SELECT 1 FROM app_settings WHERE key = 'global'"
        ).fetchone() else {}
        merged = self._deep_merge_settings(current, updates)
        self.conn.execute(
            """
            INSERT INTO app_settings(key, value_json, updated_at)
            VALUES ('global', ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at
            """,
            (json.dumps(merged), utc_now()),
        )
        self.conn.commit()
        return merged

    @staticmethod
    def _deep_merge_settings(current: dict[str, Any], updates: dict[str, Any]) -> dict[str, Any]:
        merged = dict(current)
        for key, value in updates.items():
            if isinstance(value, dict) and isinstance(merged.get(key), dict):
                merged[key] = Repository._deep_merge_settings(merged[key], value)
            else:
                merged[key] = value
        return merged

    def add_extraction_audit(self, payload: dict[str, Any]) -> dict[str, Any]:
        now = utc_now()
        audit_id = self._insert_and_get_id(
            """
            INSERT INTO extraction_audits(
                timestamp, shipment_id, message_id, provider_name, model_name, schema_name,
                decision, confidence_score, action_taken, payload_json, validation_errors_json,
                source_evidence_json, review_notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                now,
                payload.get("shipment_id"),
                payload.get("message_id"),
                payload.get("provider_name"),
                payload.get("model_name"),
                payload.get("schema_name"),
                payload.get("decision", "pending_review"),
                payload.get("confidence_score"),
                payload.get("action_taken"),
                json.dumps(payload.get("payload", {})),
                json.dumps(payload.get("validation_errors", [])),
                json.dumps(payload.get("source_evidence", [])),
                payload.get("review_notes"),
            ),
        )
        self.conn.commit()
        row = self.conn.execute(
            """
            SELECT id, timestamp, shipment_id, message_id, provider_name, model_name, schema_name,
                   decision, confidence_score, action_taken, payload_json, validation_errors_json,
                   source_evidence_json, review_notes
            FROM extraction_audits
            WHERE id = ?
            """,
            (audit_id,),
        ).fetchone()
        assert row is not None
        return self._row_to_extraction_audit(row)

    def list_extraction_audits(
        self,
        decision: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if decision:
            clauses.append("decision = ?")
            params.append(decision)
        where_clause = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self.conn.execute(
            f"""
            SELECT id, timestamp, shipment_id, message_id, provider_name, model_name, schema_name,
                   decision, confidence_score, action_taken, payload_json, validation_errors_json,
                   source_evidence_json, review_notes
            FROM extraction_audits
            {where_clause}
            ORDER BY timestamp DESC, id DESC
            LIMIT ?
            """,
            [*params, limit],
        ).fetchall()
        return [self._row_to_extraction_audit(row) for row in rows]

    @staticmethod
    def _row_to_extraction_audit(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "timestamp": row["timestamp"],
            "shipment_id": row["shipment_id"],
            "message_id": row["message_id"],
            "provider_name": row["provider_name"],
            "model_name": row["model_name"],
            "schema_name": row["schema_name"],
            "decision": row["decision"],
            "confidence_score": row["confidence_score"],
            "action_taken": row["action_taken"],
            "payload": json.loads(row["payload_json"]) if row["payload_json"] else {},
            "validation_errors": json.loads(row["validation_errors_json"]) if row["validation_errors_json"] else [],
            "source_evidence": json.loads(row["source_evidence_json"]) if row["source_evidence_json"] else [],
            "review_notes": row["review_notes"],
        }

    def list_intake_channels(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT id, channel_name, provider_type, auth_data, sync_mode, polling_interval,
                   folder_label, active, last_successful_sync, last_error, created_at, updated_at
            FROM intake_channels
            ORDER BY id DESC
            """
        ).fetchall()
        return [
            {
                "id": row["id"],
                "channel_name": row["channel_name"],
                "provider_type": row["provider_type"],
                "auth_data": json.loads(row["auth_data"]) if row["auth_data"] else {},
                "sync_mode": row["sync_mode"],
                "polling_interval": row["polling_interval"],
                "folder_label": row["folder_label"],
                "active": bool(row["active"]),
                "last_successful_sync": row["last_successful_sync"],
                "last_error": row["last_error"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]

    def list_active_intake_channels(self) -> list[dict[str, Any]]:
        return [channel for channel in self.list_intake_channels() if channel["active"]]

    def create_intake_channel(self, payload: dict[str, Any]) -> dict[str, Any]:
        now = utc_now()
        channel_id = self._insert_and_get_id(
            """
            INSERT INTO intake_channels(
                channel_name, provider_type, auth_data, sync_mode, polling_interval,
                folder_label, active, last_successful_sync, last_error, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["channel_name"],
                payload["provider_type"],
                json.dumps(payload.get("auth_data", {})),
                payload.get("sync_mode", "auto"),
                int(payload.get("polling_interval", 60)),
                payload.get("folder_label"),
                int(bool(payload.get("active", False))),
                payload.get("last_successful_sync"),
                payload.get("last_error"),
                now,
                now,
            ),
        )
        self.conn.commit()
        return self.get_intake_channel(channel_id)

    def get_intake_channel(self, channel_id: int) -> dict[str, Any]:
        row = self.conn.execute(
            """
            SELECT id, channel_name, provider_type, auth_data, sync_mode, polling_interval,
                   folder_label, active, last_successful_sync, last_error, created_at, updated_at
            FROM intake_channels WHERE id = ?
            """,
            (channel_id,),
        ).fetchone()
        if not row:
            raise ValueError(f"Intake channel id={channel_id} not found")
        return {
            "id": row["id"],
            "channel_name": row["channel_name"],
            "provider_type": row["provider_type"],
            "auth_data": json.loads(row["auth_data"]) if row["auth_data"] else {},
            "sync_mode": row["sync_mode"],
            "polling_interval": row["polling_interval"],
            "folder_label": row["folder_label"],
            "active": bool(row["active"]),
            "last_successful_sync": row["last_successful_sync"],
            "last_error": row["last_error"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def patch_intake_channel(self, channel_id: int, updates: dict[str, Any]) -> dict[str, Any]:
        current = self.get_intake_channel(channel_id)
        merged = {**current, **updates}
        self.conn.execute(
            """
            UPDATE intake_channels
            SET channel_name = ?, provider_type = ?, auth_data = ?, sync_mode = ?, polling_interval = ?,
                folder_label = ?, active = ?, last_successful_sync = ?, last_error = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                merged["channel_name"],
                merged["provider_type"],
                json.dumps(merged.get("auth_data", {})),
                merged.get("sync_mode", "auto"),
                int(merged.get("polling_interval", 60)),
                merged.get("folder_label"),
                int(bool(merged.get("active", False))),
                merged.get("last_successful_sync"),
                merged.get("last_error"),
                utc_now(),
                channel_id,
            ),
        )
        self.conn.commit()
        return self.get_intake_channel(channel_id)

    def delete_intake_channel(self, channel_id: int) -> dict[str, Any]:
        channel = self.get_intake_channel(channel_id)
        self.conn.execute("DELETE FROM intake_errors WHERE channel_id = ?", (channel_id,))
        self.conn.execute("DELETE FROM intake_channels WHERE id = ?", (channel_id,))
        self.conn.commit()
        return channel

    def add_intake_error(self, payload: dict[str, Any]) -> dict[str, Any]:
        error_id = self._insert_and_get_id(
            """
            INSERT INTO intake_errors(channel_id, timestamp, provider_message_id, error_type, error_details, retry_status, ignored_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.get("channel_id"),
                payload.get("timestamp", utc_now()),
                payload.get("provider_message_id"),
                payload["error_type"],
                payload.get("error_details"),
                payload.get("retry_status", "pending"),
                payload.get("ignored_reason"),
            ),
        )
        self.conn.commit()
        return self.get_intake_error(error_id)

    def get_intake_error(self, error_id: int) -> dict[str, Any]:
        row = self.conn.execute(
            """
            SELECT id, channel_id, timestamp, provider_message_id, error_type, error_details, retry_status, ignored_reason
            FROM intake_errors WHERE id = ?
            """,
            (error_id,),
        ).fetchone()
        if not row:
            raise ValueError(f"Intake error id={error_id} not found")
        return {
            "id": row["id"],
            "channel_id": row["channel_id"],
            "timestamp": row["timestamp"],
            "provider_message_id": row["provider_message_id"],
            "error_type": row["error_type"],
            "error_details": row["error_details"],
            "retry_status": row["retry_status"],
            "ignored_reason": row["ignored_reason"],
        }

    def list_intake_errors(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT id, channel_id, timestamp, provider_message_id, error_type, error_details, retry_status, ignored_reason
            FROM intake_errors
            ORDER BY timestamp DESC, id DESC
            """
        ).fetchall()
        return [
            {
                "id": row["id"],
                "channel_id": row["channel_id"],
                "timestamp": row["timestamp"],
                "provider_message_id": row["provider_message_id"],
                "error_type": row["error_type"],
                "error_details": row["error_details"],
                "retry_status": row["retry_status"],
                "ignored_reason": row["ignored_reason"],
            }
            for row in rows
        ]

    def retry_intake_error(self, error_id: int) -> dict[str, Any]:
        self.conn.execute(
            "UPDATE intake_errors SET retry_status = ? WHERE id = ?",
            ("retried", error_id),
        )
        self.conn.commit()
        return self.get_intake_error(error_id)

    def ignore_intake_error(self, error_id: int, reason: str) -> dict[str, Any]:
        self.conn.execute(
            "UPDATE intake_errors SET retry_status = ?, ignored_reason = ? WHERE id = ?",
            ("ignored", reason, error_id),
        )
        self.conn.commit()
        return self.get_intake_error(error_id)

    def get_metrics_snapshot(self) -> dict[str, float]:
        total_shipments = self.conn.execute("SELECT COUNT(*) AS c FROM shipments").fetchone()["c"]
        auto_created = self.conn.execute(
            "SELECT COUNT(*) AS c FROM shipments WHERE source = 'email+pdf'"
        ).fetchone()["c"]
        with_status = self.conn.execute(
            "SELECT COUNT(*) AS c FROM messages WHERE classification IS NOT NULL"
        ).fetchone()["c"]
        confident = self.conn.execute(
            "SELECT COUNT(*) AS c FROM messages WHERE confidence_score >= 0.6"
        ).fetchone()["c"]
        manual_flags = self.conn.execute(
            "SELECT COUNT(*) AS c FROM shipments WHERE manual_verification_required = 1"
        ).fetchone()["c"]

        return {
            "total_shipments": float(total_shipments),
            "auto_created_ratio": (auto_created / total_shipments) if total_shipments else 0.0,
            "classification_confidence_ratio": (confident / with_status) if with_status else 0.0,
            "manual_flag_ratio": (manual_flags / total_shipments) if total_shipments else 0.0,
        }

    def clear_operational_data(self) -> dict[str, int]:
        """
        Clear ingestion/runtime rows while preserving settings, vocabulary and intake channels.
        """
        tables = ["attachments", "messages", "audit_log", "extraction_audits", "intake_errors", "shipments"]
        counts: dict[str, int] = {}
        for table in tables:
            counts[table] = int(self.conn.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"])
        for table in tables:
            self.conn.execute(f"DELETE FROM {table}")
            if self.backend == "sqlite":
                try:
                    self.conn.execute("DELETE FROM sqlite_sequence WHERE name = ?", (table,))
                except sqlite3.DatabaseError:
                    pass
        self.conn.commit()
        return counts
