from __future__ import annotations

import csv
import io
import os
import secrets
import threading
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, Field

from .intake_service import IntakeService
from .repository import Repository
from .semantic_extractor import SemanticExtractionError, extract_email_semantics
from .status_engine import CANONICAL_STATUSES


class LoginRequest(BaseModel):
    email: str
    password: str


class ShipmentPatchRequest(BaseModel):
    customer: str | None = None
    status: str | None = None
    mx_carrier: str | None = None
    us_carrier: str | None = None
    pickup_date: str | None = None
    eta: str | None = None
    pickup_appt: str | None = None
    cross_date: str | None = None
    delivery_date: str | None = None
    delivery_appt: str | None = None
    comments: str | None = None
    owner: str | None = None
    blocked_reason: str | None = None
    manual_verification_required: bool | None = None


class OverrideRequest(BaseModel):
    field: str
    value: str | None = None
    reason: str = Field(min_length=3)


class ResolveVerificationRequest(BaseModel):
    action: Literal["accept_suggested", "keep_current"] = "keep_current"
    field: str | None = None
    suggested_value: str | None = None
    note: str | None = None


class VocabularyCreateRequest(BaseModel):
    phrase: str
    mapped_status: str
    language: str = "en"


class VocabularyPatchRequest(BaseModel):
    mapped_status: str | None = None
    language: str | None = None
    active: bool | None = None


class IntakeChannelCreateRequest(BaseModel):
    channel_name: str
    provider_type: Literal["imap", "gmail", "microsoft365"]
    auth_data: dict[str, Any] = Field(default_factory=dict)
    sync_mode: Literal["realtime", "polling", "auto"] = "auto"
    polling_interval: int = 60
    folder_label: str | None = None
    active: bool = False


class IntakeChannelPatchRequest(BaseModel):
    channel_name: str | None = None
    provider_type: Literal["imap", "gmail", "microsoft365"] | None = None
    auth_data: dict[str, Any] | None = None
    sync_mode: Literal["realtime", "polling", "auto"] | None = None
    polling_interval: int | None = None
    folder_label: str | None = None
    active: bool | None = None


class IntakeErrorIgnoreRequest(BaseModel):
    reason: str = Field(min_length=3)


class SemanticExtractionTestRequest(BaseModel):
    subject: str = ""
    body: str = Field(min_length=1)


class UserContext(BaseModel):
    email: str
    role: Literal["operations", "admin", "customer"]


_USERS = {
    "ops@whatsclear.local": {"password": "ops123", "role": "operations"},
    "admin@whatsclear.local": {"password": "admin123", "role": "admin"},
    "customer@whatsclear.local": {"password": "customer123", "role": "customer"},
}
_TOKENS: dict[str, UserContext] = {}


class IntakeWorker:
    def __init__(self, db_path: str, sheet_path: str = "master_sheet.tsv") -> None:
        self.db_path = db_path
        self.sheet_path = sheet_path
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name="whatsclear-intake", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=2)

    def _run(self) -> None:
        while not self.stop_event.wait(5):
            repo = Repository(self.db_path)
            try:
                channels = repo.list_active_intake_channels()
            finally:
                repo.close()

            now = datetime.now(timezone.utc)
            for channel in channels:
                if not self._due(channel, now):
                    continue
                IntakeService(db_path=self.db_path, sheet_path=self.sheet_path).sync_channel(channel["id"])

    @staticmethod
    def _due(channel: dict[str, Any], now: datetime) -> bool:
        last_sync = channel.get("last_successful_sync")
        if not last_sync:
            return True
        try:
            previous = datetime.fromisoformat(last_sync)
        except ValueError:
            return True
        if previous.tzinfo is None:
            previous = previous.replace(tzinfo=timezone.utc)
        return (now - previous).total_seconds() >= int(channel.get("polling_interval") or 60)


def _format_pacific(value: str | None) -> str | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    try:
        pst = dt.astimezone(ZoneInfo("America/Los_Angeles"))
    except Exception:
        # Fallback for Windows environments without IANA tz data installed.
        pst = dt.astimezone(timezone(timedelta(hours=-8)))
    return pst.strftime("%Y-%m-%d %H:%M:%S %Z")


def _derive_status(raw_status: str | None, delivery_date: str | None) -> str | None:
    if raw_status == "Delivered":
        return "Delivered"
    if raw_status in {"Pickup Completed", "Crossed", "Dispatch Pending", "Dispatched"} and not delivery_date:
        return "In Transit"
    return raw_status


def _serialize_shipment(shipment: Any) -> dict[str, Any]:
    payload = asdict(shipment)
    payload["derived_status"] = _derive_status(shipment.status, shipment.delivery_date)
    payload["created_date_pst"] = _format_pacific(shipment.created_date)
    payload["last_update_pst"] = _format_pacific(shipment.last_update)
    payload["closed_at_pst"] = _format_pacific(shipment.closed_at)
    return payload


def _parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        try:
            return datetime.strptime(value, "%Y-%m-%d")
        except ValueError:
            return None


def _avg_transit_days(shipments: list[Any]) -> float:
    diffs: list[float] = []
    now = datetime.now(timezone.utc)
    for shipment in shipments:
        pickup = _parse_date(shipment.pickup_date)
        delivery = _parse_date(shipment.delivery_date)
        if not pickup or not delivery:
            continue
        pickup_utc = pickup.astimezone(timezone.utc) if pickup.tzinfo else pickup.replace(tzinfo=timezone.utc)
        delivery_utc = delivery.astimezone(timezone.utc) if delivery.tzinfo else delivery.replace(tzinfo=timezone.utc)
        if (now - delivery_utc).days > 30:
            continue
        diffs.append((delivery_utc - pickup_utc).total_seconds() / 86400.0)
    return round(sum(diffs) / len(diffs), 1) if diffs else 0.0


def create_app(
    db_path: str | None = None,
    sheet_path: str = "master_sheet.tsv",
    enable_background_sync: bool = True,
) -> FastAPI:
    db_path = db_path or os.getenv("WHATSCLEAR_DATABASE_URL") or "whatsclear.db"
    app = FastAPI(title="WhatsClear Web API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    ui_path = Path(__file__).resolve().parent / "web_ui" / "index.html"
    intake_service = IntakeService(db_path=db_path, sheet_path=sheet_path)
    intake_worker = IntakeWorker(db_path=db_path, sheet_path=sheet_path) if enable_background_sync else None

    @app.on_event("startup")
    def startup() -> None:
        if intake_worker is not None:
            intake_worker.start()

    @app.on_event("shutdown")
    def shutdown() -> None:
        if intake_worker is not None:
            intake_worker.stop()

    def repo() -> Repository:
        return Repository(db_path=db_path)

    def require_user(authorization: str | None = Header(default=None)) -> UserContext:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing bearer token")
        token = authorization.split(" ", 1)[1]
        user = _TOKENS.get(token)
        if not user:
            raise HTTPException(status_code=401, detail="Invalid or expired token")
        return user

    def require_admin(user: UserContext = Depends(require_user)) -> UserContext:
        if user.role != "admin":
            raise HTTPException(status_code=403, detail="Admin role required")
        return user

    @app.get("/")
    def ui_root() -> FileResponse:
        return FileResponse(ui_path)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/auth/login")
    def login(payload: LoginRequest) -> dict[str, str]:
        account = _USERS.get(payload.email.strip().lower())
        if not account or account["password"] != payload.password:
            raise HTTPException(status_code=401, detail="Invalid credentials")
        token = secrets.token_urlsafe(24)
        user = UserContext(email=payload.email.strip().lower(), role=account["role"])
        _TOKENS[token] = user
        return {"access_token": token, "role": user.role, "email": user.email}

    @app.post("/auth/logout")
    def logout(
        user: UserContext = Depends(require_user),
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        del user
        token = authorization.split(" ", 1)[1] if authorization and authorization.startswith("Bearer ") else None
        if token:
            _TOKENS.pop(token, None)
        return {"ok": True}

    @app.get("/shipments")
    def get_shipments(
        q: str | None = None,
        status: str | None = None,
        lane: str | None = None,
        owner: str | None = None,
        blocked: bool | None = None,
        manual_verification: bool | None = None,
        include_closed: bool = False,
        sort_by: str = "last_update",
        sort_dir: str = "desc",
        page: int = 1,
        page_size: int = 50,
        _: UserContext = Depends(require_user),
    ) -> dict[str, Any]:
        r = repo()
        try:
            rows = r.query_shipments(
                q=q,
                status=status,
                lane=lane,
                owner=owner,
                blocked=blocked,
                manual_verification=manual_verification,
                include_closed=include_closed,
                sort_by=sort_by,
                sort_dir=sort_dir,
            )
            total = len(rows)
            start = max(0, (page - 1) * page_size)
            data = rows[start : start + page_size]
            return {
                "items": [_serialize_shipment(s) for s in data],
                "page": page,
                "page_size": page_size,
                "total": total,
            }
        finally:
            r.close()

    @app.get("/shipments/export")
    def export_shipments_csv(
        format: str = Query(default="csv"),
        q: str | None = None,
        status: str | None = None,
        lane: str | None = None,
        owner: str | None = None,
        blocked: bool | None = None,
        manual_verification: bool | None = None,
        include_closed: bool = False,
        sort_by: str = "last_update",
        sort_dir: str = "desc",
        _: UserContext = Depends(require_user),
    ) -> PlainTextResponse:
        if format.lower() != "csv":
            raise HTTPException(status_code=400, detail="Only csv export is supported")
        r = repo()
        try:
            rows = r.query_shipments(
                q=q,
                status=status,
                lane=lane,
                owner=owner,
                blocked=blocked,
                manual_verification=manual_verification,
                include_closed=include_closed,
                sort_by=sort_by,
                sort_dir=sort_dir,
            )
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(
                [
                    "id",
                    "shipment_number",
                    "customer",
                    "lane",
                    "invoice_number",
                    "bol_number",
                    "po_number",
                    "pickup_date",
                    "eta",
                    "mx_carrier",
                    "us_carrier",
                    "status",
                    "derived_status",
                    "blocked_reason",
                    "owner",
                    "created_date_pst",
                    "last_update",
                    "last_update_pst",
                    "comments",
                    "manual_verification_required",
                    "lifecycle_state",
                    "closed_at_pst",
                    "closed_reason",
                    "auto_closed",
                ]
            )
            for s in rows:
                serialized = _serialize_shipment(s)
                writer.writerow(
                    [
                        s.id,
                        s.shipment_number or "",
                        s.customer or "",
                        s.lane or "",
                        s.invoice_number or "",
                        s.bol_number or "",
                        s.po_number or "",
                        s.pickup_date or "",
                        s.eta or "",
                        s.mx_carrier or "",
                        s.us_carrier or "",
                        s.status or "",
                        serialized.get("derived_status") or "",
                        s.blocked_reason or "",
                        s.owner or "",
                        serialized.get("created_date_pst") or "",
                        s.last_update,
                        serialized.get("last_update_pst") or "",
                        s.comments or "",
                        "TRUE" if s.manual_verification_required else "FALSE",
                        s.lifecycle_state,
                        serialized.get("closed_at_pst") or "",
                        s.closed_reason or "",
                        "TRUE" if s.auto_closed else "FALSE",
                    ]
                )
            return PlainTextResponse(
                content=output.getvalue(),
                media_type="text/csv",
                headers={"Content-Disposition": 'attachment; filename="shipments.csv"'},
            )
        finally:
            r.close()

    @app.get("/shipments/{shipment_id}")
    def get_shipment(shipment_id: int, _: UserContext = Depends(require_user)) -> dict[str, Any]:
        r = repo()
        try:
            shipment = r.get_shipment_by_id(shipment_id)
            if not shipment:
                raise HTTPException(status_code=404, detail="Shipment not found")
            return _serialize_shipment(shipment)
        finally:
            r.close()

    @app.patch("/shipments/{shipment_id}")
    def patch_shipment(
        shipment_id: int,
        payload: ShipmentPatchRequest,
        user: UserContext = Depends(require_user),
    ) -> dict[str, Any]:
        updates = payload.model_dump(exclude_unset=True)
        if "status" in updates and updates["status"] and updates["status"] not in CANONICAL_STATUSES:
            raise HTTPException(status_code=400, detail="Invalid canonical status")
        r = repo()
        try:
            shipment = r.update_shipment_fields(
                shipment_id=shipment_id,
                updates=updates,
                actor=user.email,
                preserve_manual_fields=False,
            )
            return _serialize_shipment(shipment)
        finally:
            r.close()

    @app.post("/shipments/{shipment_id}/override")
    def post_override(
        shipment_id: int,
        payload: OverrideRequest,
        user: UserContext = Depends(require_user),
    ) -> dict[str, Any]:
        r = repo()
        try:
            shipment = r.update_shipment_fields(
                shipment_id=shipment_id,
                updates={payload.field: payload.value, "manual_verification_required": True},
                actor=f"{user.email}:override:{payload.reason}",
                preserve_manual_fields=False,
            )
            return _serialize_shipment(shipment)
        finally:
            r.close()

    @app.get("/verification-items")
    def get_verification_items(
        owner: str | None = None,
        _: UserContext = Depends(require_user),
    ) -> dict[str, list[dict[str, Any]]]:
        r = repo()
        try:
            rows = r.query_shipments(owner=owner, manual_verification=True, sort_by="last_update", sort_dir="desc")
            items: list[dict[str, Any]] = []
            for shipment in rows:
                items.append(
                    {
                        "id": f"shipment-{shipment.id}-manual",
                        "shipment_id": shipment.id,
                        "shipment_number": shipment.shipment_number,
                        "flag_type": "manual_verification_required",
                        "field": "manual_verification_required",
                        "current_value": "TRUE",
                        "suggested_value": "FALSE",
                        "detected_at": shipment.last_update,
                        "owner": shipment.owner,
                    }
                )
            return {"items": items}
        finally:
            r.close()

    @app.post("/verification-items/{item_id}/resolve")
    def resolve_verification(
        item_id: str,
        payload: ResolveVerificationRequest,
        user: UserContext = Depends(require_user),
    ) -> dict[str, Any]:
        try:
            shipment_id = int(item_id.split("-")[1])
        except (IndexError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="Invalid verification item id") from exc

        updates: dict[str, Any] = {"manual_verification_required": False}
        if payload.action == "accept_suggested" and payload.field and payload.suggested_value is not None:
            updates[payload.field] = payload.suggested_value
        r = repo()
        try:
            shipment = r.update_shipment_fields(
                shipment_id=shipment_id,
                updates=updates,
                actor=f"{user.email}:resolve:{payload.note or 'none'}",
                preserve_manual_fields=False,
            )
            return {"resolved": True, "shipment": _serialize_shipment(shipment)}
        finally:
            r.close()

    @app.get("/metrics")
    def get_metrics(_: UserContext = Depends(require_user)) -> dict[str, float]:
        r = repo()
        try:
            base = r.get_metrics_snapshot()
            r.auto_close_delivered_shipments(retention_days=1)
            shipments = r.list_shipments()
            active_shipments = [s for s in shipments if (s.lifecycle_state or "active") == "active"]
            delivered_today = 0.0
            today = datetime.now(timezone.utc).date()
            for s in shipments:
                delivery = _parse_date(s.delivery_date)
                if delivery and delivery.date() == today:
                    delivered_today += 1.0
            base["active_shipments"] = float(len(active_shipments))
            base["blocked_shipments"] = float(sum(1 for s in active_shipments if bool(s.blocked_reason)))
            base["manual_verification_required"] = float(sum(1 for s in active_shipments if s.manual_verification_required))
            base["delivered_today"] = delivered_today
            base["average_transit_days"] = _avg_transit_days(shipments)
            base["messages_processed"] = float(r.conn.execute("SELECT COUNT(*) AS c FROM messages").fetchone()["c"])
            base["non_digital_pdf_detections"] = float(
                r.conn.execute("SELECT COUNT(*) AS c FROM attachments WHERE is_digital_pdf = 0").fetchone()["c"]
            )
            return base
        finally:
            r.close()

    @app.get("/vocabulary")
    def get_vocabulary(_: UserContext = Depends(require_admin)) -> dict[str, Any]:
        r = repo()
        try:
            return {"items": r.list_vocabulary()}
        finally:
            r.close()

    @app.post("/vocabulary")
    def create_vocabulary(
        payload: VocabularyCreateRequest,
        _: UserContext = Depends(require_admin),
    ) -> dict[str, Any]:
        if payload.mapped_status not in CANONICAL_STATUSES:
            raise HTTPException(status_code=400, detail="mapped_status must be canonical")
        r = repo()
        try:
            r.upsert_vocabulary(payload.phrase, payload.mapped_status, payload.language)
            return {"ok": True, "phrase": payload.phrase.lower()}
        finally:
            r.close()

    @app.patch("/vocabulary/{phrase}")
    def patch_vocabulary(
        phrase: str,
        payload: VocabularyPatchRequest,
        _: UserContext = Depends(require_admin),
    ) -> dict[str, Any]:
        if payload.mapped_status and payload.mapped_status not in CANONICAL_STATUSES:
            raise HTTPException(status_code=400, detail="mapped_status must be canonical")
        r = repo()
        try:
            return r.patch_vocabulary(phrase, payload.mapped_status, payload.language, payload.active)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        finally:
            r.close()

    @app.get("/audit-log")
    def get_audit_log(
        shipment_id: int | None = None,
        actor: str | None = None,
        field: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        format: str | None = None,
        _: UserContext = Depends(require_admin),
    ) -> Any:
        r = repo()
        try:
            rows = r.list_audit_log(
                shipment_id=shipment_id,
                actor=actor,
                field=field,
                date_from=date_from,
                date_to=date_to,
            )
            if format == "csv":
                output = io.StringIO()
                writer = csv.writer(output)
                writer.writerow(["timestamp", "shipment_id", "field", "old_value", "new_value", "actor"])
                for row in rows:
                    writer.writerow(
                        [
                            row["timestamp"],
                            row["shipment_id"] or "",
                            row["field"],
                            row["old_value"] or "",
                            row["new_value"] or "",
                            row["actor"],
                        ]
                    )
                return PlainTextResponse(
                    content=output.getvalue(),
                    media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="audit_log.csv"'},
                )
            return {"items": rows}
        finally:
            r.close()

    @app.get("/settings")
    def get_settings(_: UserContext = Depends(require_admin)) -> dict[str, Any]:
        r = repo()
        try:
            return r.get_settings()
        finally:
            r.close()

    @app.patch("/settings")
    def patch_settings(payload: dict[str, Any], _: UserContext = Depends(require_admin)) -> dict[str, Any]:
        r = repo()
        try:
            return r.patch_settings(payload)
        finally:
            r.close()

    @app.post("/semantic-extraction/test")
    def test_semantic_extraction(
        payload: SemanticExtractionTestRequest,
        _: UserContext = Depends(require_admin),
    ) -> dict[str, Any]:
        r = repo()
        try:
            settings = r.get_settings()
        finally:
            r.close()
        semantic_settings = settings.get("semantic_extraction", {})
        if not semantic_settings.get("enabled"):
            raise HTTPException(status_code=400, detail="Semantic extraction is disabled in settings")
        try:
            result = extract_email_semantics(
                subject=payload.subject,
                body=payload.body,
                settings={
                    **semantic_settings,
                    "schema_name": settings.get("schema_validation", {}).get("schema_name", "shipment_event_v1"),
                },
            )
        except SemanticExtractionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if result is None:
            raise HTTPException(status_code=400, detail="Semantic endpoint is not configured")
        return {
            "provider_name": result.provider_name,
            "model_name": result.model_name,
            "schema_name": result.schema_name,
            "confidence": result.confidence,
            "status": result.status,
            "blocked_reason": result.blocked_reason,
            "extracted_data": result.extracted_data,
            "source_evidence": result.source_evidence,
            "review_notes": result.review_notes,
            "raw_payload": result.raw_payload,
        }

    @app.get("/extraction-audits")
    def get_extraction_audits(
        decision: str | None = None,
        limit: int = 100,
        _: UserContext = Depends(require_admin),
    ) -> dict[str, Any]:
        r = repo()
        try:
            return {"items": r.list_extraction_audits(decision=decision, limit=limit)}
        finally:
            r.close()

    @app.get("/intake/channels")
    def get_channels(_: UserContext = Depends(require_admin)) -> dict[str, Any]:
        r = repo()
        try:
            return {"items": r.list_intake_channels()}
        finally:
            r.close()

    @app.post("/intake/channels")
    def create_channel(
        payload: IntakeChannelCreateRequest,
        _: UserContext = Depends(require_admin),
    ) -> dict[str, Any]:
        r = repo()
        try:
            return r.create_intake_channel(payload.model_dump())
        finally:
            r.close()

    @app.patch("/intake/channels/{channel_id}")
    def patch_channel(
        channel_id: int,
        payload: IntakeChannelPatchRequest,
        _: UserContext = Depends(require_admin),
    ) -> dict[str, Any]:
        r = repo()
        try:
            return r.patch_intake_channel(channel_id, payload.model_dump(exclude_unset=True))
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        finally:
            r.close()

    @app.post("/intake/channels/{channel_id}/test")
    def test_channel(channel_id: int, _: UserContext = Depends(require_admin)) -> dict[str, Any]:
        result = intake_service.sync_channel(channel_id)
        if result["error"]:
            raise HTTPException(status_code=400, detail=result["error"])
        return {"ok": True, "result": result}

    @app.post("/intake/channels/{channel_id}/sync")
    def sync_channel(channel_id: int, _: UserContext = Depends(require_admin)) -> dict[str, Any]:
        result = intake_service.sync_channel(channel_id)
        if result["error"]:
            raise HTTPException(status_code=400, detail=result["error"])
        return result

    @app.post("/intake/sync")
    def sync_active_channels(_: UserContext = Depends(require_admin)) -> dict[str, Any]:
        return intake_service.sync_active_channels()

    @app.post("/admin/clear-test-data")
    def clear_test_data(_: UserContext = Depends(require_admin)) -> dict[str, Any]:
        r = repo()
        try:
            deleted = r.clear_operational_data()
        finally:
            r.close()
        try:
            sheet_file = Path(sheet_path)
            if sheet_file.exists():
                sheet_file.unlink()
        except OSError:
            pass
        return {"ok": True, "deleted": deleted}

    @app.post("/intake/channels/{channel_id}/activate")
    def activate_channel(channel_id: int, _: UserContext = Depends(require_admin)) -> dict[str, Any]:
        r = repo()
        try:
            return r.patch_intake_channel(channel_id, {"active": True})
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        finally:
            r.close()

    @app.post("/intake/channels/{channel_id}/deactivate")
    def deactivate_channel(channel_id: int, _: UserContext = Depends(require_admin)) -> dict[str, Any]:
        r = repo()
        try:
            return r.patch_intake_channel(channel_id, {"active": False})
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        finally:
            r.close()

    @app.delete("/intake/channels/{channel_id}")
    def delete_channel(channel_id: int, _: UserContext = Depends(require_admin)) -> dict[str, Any]:
        r = repo()
        try:
            deleted = r.delete_intake_channel(channel_id)
            return {"deleted": True, "channel": deleted}
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        finally:
            r.close()

    @app.get("/intake/errors")
    def get_intake_errors(_: UserContext = Depends(require_admin)) -> dict[str, Any]:
        r = repo()
        try:
            return {"items": r.list_intake_errors()}
        finally:
            r.close()

    @app.post("/intake/errors/{error_id}/retry")
    def retry_intake_error(error_id: int, _: UserContext = Depends(require_admin)) -> dict[str, Any]:
        r = repo()
        try:
            return r.retry_intake_error(error_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        finally:
            r.close()

    @app.post("/intake/errors/{error_id}/ignore")
    def ignore_intake_error(
        error_id: int,
        payload: IntakeErrorIgnoreRequest,
        _: UserContext = Depends(require_admin),
    ) -> dict[str, Any]:
        r = repo()
        try:
            return r.ignore_intake_error(error_id, payload.reason)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        finally:
            r.close()

    return app
