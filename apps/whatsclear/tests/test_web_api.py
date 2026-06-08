from __future__ import annotations

from fastapi.testclient import TestClient

import whatsclear.web_api as web_api_module
from whatsclear.models import SemanticExtractionResult
from whatsclear.repository import Repository
from whatsclear.web_api import create_app


def _seed_data(db_path: str) -> None:
    repo = Repository(db_path)
    repo.create_shipment(
        {
            "shipment_number": "LOAD-100",
            "lane": "MX->US",
            "status": "Pickup Completed",
            "pickup_date": "2026-03-04",
            "owner": "ops-a",
            "manual_verification_required": True,
            "source": "email+pdf",
        }
    )
    repo.close()


def _login(client: TestClient, email: str, password: str) -> str:
    res = client.post("/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200
    return res.json()["access_token"]


def test_shipments_and_verification_flow(tmp_path):
    db_path = str(tmp_path / "web.db")
    _seed_data(db_path)
    client = TestClient(create_app(db_path=db_path))
    token = _login(client, "ops@whatsclear.local", "ops123")
    headers = {"Authorization": f"Bearer {token}"}

    shipments = client.get("/shipments", headers=headers)
    assert shipments.status_code == 200
    assert shipments.json()["total"] == 1
    item = shipments.json()["items"][0]
    assert item["derived_status"] == "In Transit"
    assert item["created_date_pst"]

    verif = client.get("/verification-items", headers=headers)
    assert verif.status_code == 200
    item_id = verif.json()["items"][0]["id"]

    resolved = client.post(
        f"/verification-items/{item_id}/resolve",
        json={"action": "keep_current", "note": "done"},
        headers=headers,
    )
    assert resolved.status_code == 200
    assert resolved.json()["resolved"] is True

    shipment_id = shipments.json()["items"][0]["id"]
    update = client.patch(
        f"/shipments/{shipment_id}",
        json={"status": "Delivered", "owner": "ops-b"},
        headers=headers,
    )
    assert update.status_code == 200
    assert update.json()["status"] == "Delivered"
    assert update.json()["derived_status"] == "Delivered"

    export = client.get("/shipments/export?format=csv", headers=headers)
    assert export.status_code == 200
    assert "shipment_number" in export.text


def test_admin_endpoints_require_admin_role(tmp_path):
    db_path = str(tmp_path / "web.db")
    _seed_data(db_path)
    client = TestClient(create_app(db_path=db_path))
    token = _login(client, "ops@whatsclear.local", "ops123")
    headers = {"Authorization": f"Bearer {token}"}
    res = client.get("/vocabulary", headers=headers)
    assert res.status_code == 403

    admin_token = _login(client, "admin@whatsclear.local", "admin123")
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    create = client.post(
        "/vocabulary",
        json={"phrase": "in customs", "mapped_status": "Import Cleared", "language": "en"},
        headers=admin_headers,
    )
    assert create.status_code == 200
    vocab = client.get("/vocabulary", headers=admin_headers)
    assert vocab.status_code == 200
    assert any(v["phrase"] == "in customs" for v in vocab.json()["items"])

    channel = client.post(
        "/intake/channels",
        json={
            "channel_name": "ops-imap",
            "provider_type": "imap",
            "auth_data": {"host": "imap.gmail.com", "username": "u", "password": "p"},
            "sync_mode": "polling",
            "polling_interval": 60,
            "folder_label": "INBOX",
            "active": False,
        },
        headers=admin_headers,
    )
    assert channel.status_code == 200
    channel_id = channel.json()["id"]

    deleted = client.delete(f"/intake/channels/{channel_id}", headers=admin_headers)
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] is True


def test_logout_revokes_token(tmp_path):
    db_path = str(tmp_path / "web.db")
    _seed_data(db_path)
    client = TestClient(create_app(db_path=db_path))
    token = _login(client, "ops@whatsclear.local", "ops123")
    headers = {"Authorization": f"Bearer {token}"}

    pre = client.get("/shipments", headers=headers)
    assert pre.status_code == 200

    out = client.post("/auth/logout", headers=headers)
    assert out.status_code == 200
    assert out.json()["ok"] is True

    post = client.get("/shipments", headers=headers)
    assert post.status_code == 401


def test_admin_can_test_semantic_endpoint(tmp_path, monkeypatch):
    db_path = str(tmp_path / "web.db")
    _seed_data(db_path)
    repo = Repository(db_path)
    repo.patch_settings(
        {
            "semantic_extraction": {
                "enabled": True,
                "provider": "openai",
                "model": "gpt-4.1-mini",
                "endpoint": "http://semantic.local/extract",
            }
        }
    )
    repo.close()

    def fake_extract_email_semantics(subject: str, body: str, settings: dict):
        assert subject == "Re: next load"
        assert "picked up now" in body.lower()
        assert settings["endpoint"] == "http://semantic.local/extract"
        return SemanticExtractionResult(
            provider_name="openai",
            model_name="gpt-4.1-mini",
            schema_name="shipment_event_v1",
            confidence=0.92,
            extracted_data={"us_carrier": "JB Hunt"},
            status="Pickup Completed",
            source_evidence=["picked up now", "carrier is JB Hunt"],
            raw_payload={"confidence": 0.92},
        )

    monkeypatch.setattr(web_api_module, "extract_email_semantics", fake_extract_email_semantics)
    client = TestClient(create_app(db_path=db_path))
    token = _login(client, "admin@whatsclear.local", "admin123")
    headers = {"Authorization": f"Bearer {token}"}

    response = client.post(
        "/semantic-extraction/test",
        json={"subject": "Re: next load", "body": "Load has been picked up now, carrier is JB Hunt."},
        headers=headers,
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "Pickup Completed"
    assert payload["extracted_data"]["us_carrier"] == "JB Hunt"
