from __future__ import annotations

import base64
from datetime import datetime, timezone
from pathlib import Path

from .models import EmailMessage


class GmailAdapter:
    """
    Lightweight Gmail polling adapter.
    Requires credentials via service account/user OAuth handled by google-auth defaults.
    """

    def __init__(self) -> None:
        from googleapiclient.discovery import build

        self.service = build("gmail", "v1")

    def list_recent_messages(self, max_results: int = 20, query: str = "newer_than:2d") -> list[EmailMessage]:
        response = self.service.users().messages().list(userId="me", maxResults=max_results, q=query).execute()
        ids = [m["id"] for m in response.get("messages", [])]
        messages: list[EmailMessage] = []
        for msg_id in ids:
            raw = self.service.users().messages().get(userId="me", id=msg_id, format="full").execute()
            messages.append(self._to_message(raw))
        return messages

    def _to_message(self, raw: dict) -> EmailMessage:
        payload = raw.get("payload", {})
        headers = {h["name"].lower(): h["value"] for h in payload.get("headers", [])}
        subject = headers.get("subject", "")
        thread_id = raw.get("threadId")
        internal_date = int(raw.get("internalDate", "0")) / 1000
        body = self._extract_body(payload)
        attachments = self._extract_pdf_attachments(raw.get("id"), payload)

        return EmailMessage(
            message_id=raw["id"],
            thread_id=thread_id,
            subject=subject,
            body=body,
            timestamp=datetime.fromtimestamp(internal_date, tz=timezone.utc),
            attachments=attachments,
        )

    def _extract_body(self, payload: dict) -> str:
        parts = payload.get("parts", [])
        if not parts and payload.get("body", {}).get("data"):
            return self._decode_body(payload["body"]["data"])
        for part in parts:
            if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
                return self._decode_body(part["body"]["data"])
        return ""

    @staticmethod
    def _decode_body(data: str) -> str:
        return base64.urlsafe_b64decode(data.encode("utf-8")).decode("utf-8", errors="ignore")

    def _extract_pdf_attachments(self, message_id: str, payload: dict) -> list[str]:
        out_dir = Path("attachments")
        out_dir.mkdir(exist_ok=True)
        saved: list[str] = []

        for part in payload.get("parts", []):
            filename = part.get("filename", "")
            if not filename.lower().endswith(".pdf"):
                continue
            attach_id = part.get("body", {}).get("attachmentId")
            if not attach_id:
                continue
            raw = (
                self.service.users()
                .messages()
                .attachments()
                .get(userId="me", messageId=message_id, id=attach_id)
                .execute()
            )
            decoded = base64.urlsafe_b64decode(raw["data"].encode("utf-8"))
            output = out_dir / filename
            output.write_bytes(decoded)
            saved.append(str(output))
        return saved
