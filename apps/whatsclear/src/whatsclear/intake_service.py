from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Callable
import os
import re

from .gmail_adapter import GmailAdapter
from .imap_adapter import ImapAdapter
from .pipeline import WhatsClearPipeline
from .repository import Repository
from .sheets import LocalSheetSync


class IntakeService:
    def __init__(
        self,
        db_path: str | None = None,
        sheet_path: str = "master_sheet.tsv",
        gmail_adapter_factory: Callable[[], Any] | None = None,
        imap_adapter_factory: Callable[..., Any] | None = None,
    ) -> None:
        self.db_path = db_path or os.getenv("WHATSCLEAR_DATABASE_URL") or "whatsclear.db"
        self.sheet_path = sheet_path
        self.gmail_adapter_factory = gmail_adapter_factory or GmailAdapter
        self.imap_adapter_factory = imap_adapter_factory or ImapAdapter

    def sync_active_channels(self) -> dict[str, Any]:
        repo = Repository(self.db_path)
        try:
            channels = repo.list_active_intake_channels()
        finally:
            repo.close()

        items = [self.sync_channel(channel["id"]) for channel in channels]
        return {
            "channels": items,
            "synced_channels": len(items),
            "processed_messages": sum(item["processed_messages"] for item in items),
            "created_shipments": sum(item["created_shipments"] for item in items),
        }

    def sync_channel(self, channel_id: int) -> dict[str, Any]:
        repo = Repository(self.db_path)
        try:
            channel = repo.get_intake_channel(channel_id)
        finally:
            repo.close()

        if not channel["active"]:
            return self._result(channel, 0, 0, 0, "Channel is inactive")

        try:
            messages = self._fetch_messages(channel)
            messages = self._apply_start_from_now(channel, messages)
            result = self._process_messages(channel, messages)
            self._mark_channel_success(channel_id)
            return result
        except Exception as exc:
            self._mark_channel_error(channel_id, str(exc))
            return self._result(channel, 0, 0, 0, str(exc))

    def _fetch_messages(self, channel: dict[str, Any]) -> list[Any]:
        auth_data = channel.get("auth_data") or {}
        folder_label = channel.get("folder_label") or auth_data.get("folder") or "INBOX"
        max_results = int(auth_data.get("max_results", 20))
        query = (auth_data.get("query") or "").strip()

        if channel["provider_type"] == "gmail":
            adapter = self.gmail_adapter_factory()
            query = auth_data.get("query") or "newer_than:2d"
            return adapter.list_recent_messages(max_results=max_results, query=query)

        if channel["provider_type"] == "imap":
            host = auth_data.get("host") or "imap.gmail.com"
            username = auth_data.get("username")
            password = auth_data.get("password")
            if not username or not password:
                raise ValueError("IMAP auth_data requires username and password")
            port = int(auth_data.get("port", 993))
            use_ssl = bool(auth_data.get("use_ssl", True))
            criteria = auth_data.get("search_criteria") or "ALL"
            adapter = self.imap_adapter_factory(
                host=host,
                username=username,
                password=password,
                port=port,
                use_ssl=use_ssl,
            )
            messages = adapter.list_recent_messages(folder=folder_label, search_criteria=criteria, max_results=max_results)
            return self._filter_imap_messages(messages, query)

        raise ValueError(f"Unsupported provider type: {channel['provider_type']}")

    @staticmethod
    def _apply_start_from_now(channel: dict[str, Any], messages: list[Any]) -> list[Any]:
        auth_data = channel.get("auth_data") or {}
        start_from_now = bool(auth_data.get("start_from_now", True))
        if not start_from_now:
            return messages
        if channel.get("last_successful_sync"):
            return messages
        created_at = channel.get("created_at")
        if not created_at:
            return messages
        try:
            cutoff = datetime.fromisoformat(created_at)
        except ValueError:
            return messages
        if cutoff.tzinfo is None:
            cutoff = cutoff.replace(tzinfo=timezone.utc)
        return [m for m in messages if getattr(m, "timestamp", cutoff) >= cutoff]

    @staticmethod
    def _filter_imap_messages(messages: list[Any], query: str) -> list[Any]:
        """
        Supports a small Gmail-like subset for IMAP channels:
        - newer_than:Nm / Nh / Nd
        - has:attachment
        """
        if not query:
            return messages

        filtered = list(messages)
        q = query.lower()

        newer_than = re.search(r"newer_than:(\d+)\s*([mhd])", q)
        if newer_than:
            amount = int(newer_than.group(1))
            unit = newer_than.group(2)
            if unit == "m":
                cutoff = datetime.now(timezone.utc) - timedelta(minutes=amount)
            elif unit == "h":
                cutoff = datetime.now(timezone.utc) - timedelta(hours=amount)
            else:
                cutoff = datetime.now(timezone.utc) - timedelta(days=amount)
            filtered = [m for m in filtered if getattr(m, "timestamp", cutoff) >= cutoff]

        if "has:attachment" in q:
            filtered = [m for m in filtered if bool(getattr(m, "attachments", []))]

        return filtered

    def _process_messages(self, channel: dict[str, Any], messages: list[Any]) -> dict[str, Any]:
        repo = Repository(self.db_path)
        sync = LocalSheetSync(self.sheet_path)
        pipeline = WhatsClearPipeline(repository=repo, sheet_sync=sync)
        processed_messages = 0
        created_shipments = 0
        skipped_messages = 0
        known_shipment_ids = {s.id for s in repo.list_shipments()}
        try:
            for message in messages:
                if not self._is_operational_message(message):
                    skipped_messages += 1
                    continue
                before = repo.get_message_record(message.message_id)
                shipment, _flags = pipeline.process_message(message)
                if before:
                    skipped_messages += 1
                    continue
                processed_messages += 1
                if shipment.id not in known_shipment_ids:
                    known_shipment_ids.add(shipment.id)
                    created_shipments += 1
        finally:
            pipeline.close()

        return self._result(channel, processed_messages, created_shipments, skipped_messages, None)

    @staticmethod
    def _is_operational_message(message: Any) -> bool:
        if getattr(message, "attachments", None):
            return True
        blob = f"{getattr(message, 'subject', '')}\n{getattr(message, 'body', '')}".lower()
        # Skip obvious non-shipment inbox noise when no attachments are present.
        noise_markers = ["notifications.google.com", "security alert", "verification code", "password", "sign-in"]
        if any(marker in blob for marker in noise_markers):
            return False
        operational_markers = [
            "shipment",
            "pickup",
            "pick up",
            "picked up",
            "has been picked up",
            "was picked up",
            "delivery",
            "dispatch",
            "carrier",
            "bol",
            "invoice",
            "reference number",
            "po ",
            "crossed",
        ]
        if any(marker in blob for marker in operational_markers):
            return True
        if re.search(r"\b[A-Za-z .'-]+,\s*[A-Z]{2,5}\s*(?:->|to)\s*[A-Za-z .'-]+,\s*[A-Z]{2,5}\b", blob, re.I):
            return True
        return False

    def _mark_channel_success(self, channel_id: int) -> None:
        repo = Repository(self.db_path)
        try:
            repo.patch_intake_channel(
                channel_id,
                {
                    "last_successful_sync": datetime.now(timezone.utc).isoformat(),
                    "last_error": None,
                },
            )
        finally:
            repo.close()

    def _mark_channel_error(self, channel_id: int, error: str) -> None:
        repo = Repository(self.db_path)
        try:
            repo.patch_intake_channel(channel_id, {"last_error": error})
            repo.add_intake_error(
                {
                    "channel_id": channel_id,
                    "error_type": "sync_error",
                    "error_details": error,
                }
            )
        finally:
            repo.close()

    @staticmethod
    def _result(
        channel: dict[str, Any],
        processed_messages: int,
        created_shipments: int,
        skipped_messages: int,
        error: str | None,
    ) -> dict[str, Any]:
        return {
            "channel_id": channel["id"],
            "channel_name": channel["channel_name"],
            "provider_type": channel["provider_type"],
            "processed_messages": processed_messages,
            "created_shipments": created_shipments,
            "skipped_messages": skipped_messages,
            "error": error,
        }
