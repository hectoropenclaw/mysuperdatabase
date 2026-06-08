from __future__ import annotations

import email
import imaplib
import re
from datetime import datetime, timezone
from email.message import Message
from email.utils import parsedate_to_datetime
from pathlib import Path

from .models import EmailMessage


class ImapAdapter:
    def __init__(
        self,
        host: str,
        username: str,
        password: str,
        port: int = 993,
        use_ssl: bool = True,
        attachment_dir: str | Path = "attachments",
    ) -> None:
        self.host = host
        self.username = username
        self.password = password
        self.port = port
        self.use_ssl = use_ssl
        self.attachment_dir = Path(attachment_dir)

    def list_recent_messages(
        self,
        folder: str = "INBOX",
        search_criteria: str = "ALL",
        max_results: int = 20,
    ) -> list[EmailMessage]:
        client = imaplib.IMAP4_SSL(self.host, self.port) if self.use_ssl else imaplib.IMAP4(self.host, self.port)
        try:
            client.login(self.username, self.password)
            status, _ = client.select(folder)
            if status != "OK":
                raise RuntimeError(f"Unable to open IMAP folder: {folder}")

            status, data = client.search(None, search_criteria)
            if status != "OK":
                raise RuntimeError(f"IMAP search failed for criteria: {search_criteria}")

            ids = [item for item in data[0].split() if item][-max_results:]
            messages: list[EmailMessage] = []
            for msg_id in reversed(ids):
                status, raw_parts = client.fetch(msg_id, "(RFC822)")
                if status != "OK" or not raw_parts:
                    continue
                raw_email = next((part[1] for part in raw_parts if isinstance(part, tuple) and len(part) > 1), None)
                if not raw_email:
                    continue
                parsed = email.message_from_bytes(raw_email)
                messages.append(self._to_message(msg_id.decode("utf-8"), parsed))
            return messages
        finally:
            try:
                client.close()
            except Exception:
                pass
            client.logout()

    def _to_message(self, fallback_id: str, parsed: Message) -> EmailMessage:
        message_id = (parsed.get("Message-ID") or fallback_id).strip()
        thread_id = self._thread_key(parsed, message_id)
        subject = self._decode_header_value(parsed.get("Subject"))
        body = self._extract_body(parsed)
        timestamp = self._extract_timestamp(parsed)
        attachments = self._extract_pdf_attachments(message_id, parsed)
        return EmailMessage(
            message_id=message_id,
            thread_id=thread_id,
            subject=subject,
            body=body,
            timestamp=timestamp,
            attachments=attachments,
        )

    @staticmethod
    def _thread_key(parsed: Message, message_id: str) -> str:
        references = parsed.get("References") or ""
        reference_tokens = re.findall(r"<[^>]+>", references)
        if reference_tokens:
            return reference_tokens[0]

        in_reply_to = parsed.get("In-Reply-To") or ""
        reply_tokens = re.findall(r"<[^>]+>", in_reply_to)
        if reply_tokens:
            return reply_tokens[0]

        return message_id

    @staticmethod
    def _decode_header_value(value: str | None) -> str:
        if not value:
            return ""
        decoded = email.header.decode_header(value)
        chunks: list[str] = []
        for raw, charset in decoded:
            if isinstance(raw, bytes):
                chunks.append(raw.decode(charset or "utf-8", errors="ignore"))
            else:
                chunks.append(raw)
        return "".join(chunks)

    def _extract_body(self, parsed: Message) -> str:
        if parsed.is_multipart():
            for part in parsed.walk():
                content_type = part.get_content_type()
                disposition = str(part.get("Content-Disposition") or "")
                if content_type == "text/plain" and "attachment" not in disposition.lower():
                    payload = part.get_payload(decode=True) or b""
                    charset = part.get_content_charset() or "utf-8"
                    return payload.decode(charset, errors="ignore")
            return ""
        payload = parsed.get_payload(decode=True) or b""
        charset = parsed.get_content_charset() or "utf-8"
        return payload.decode(charset, errors="ignore")

    @staticmethod
    def _extract_timestamp(parsed: Message) -> datetime:
        raw_date = parsed.get("Date")
        if not raw_date:
            return datetime.now(timezone.utc)
        parsed_date = parsedate_to_datetime(raw_date)
        if parsed_date.tzinfo is None:
            return parsed_date.replace(tzinfo=timezone.utc)
        return parsed_date.astimezone(timezone.utc)

    def _extract_pdf_attachments(self, message_id: str, parsed: Message) -> list[str]:
        message_dir = self.attachment_dir / self._safe_message_dir(message_id)
        message_dir.mkdir(parents=True, exist_ok=True)
        saved: list[str] = []
        for part in parsed.walk():
            filename = part.get_filename()
            if not filename or not filename.lower().endswith(".pdf"):
                continue
            payload = part.get_payload(decode=True)
            if payload is None:
                continue
            safe_name = Path(filename).name
            output = message_dir / safe_name
            output.write_bytes(payload)
            saved.append(str(output))
        return saved

    @staticmethod
    def _safe_message_dir(message_id: str) -> str:
        return "".join(ch for ch in message_id if ch.isalnum() or ch in {"-", "_"}) or "message"
