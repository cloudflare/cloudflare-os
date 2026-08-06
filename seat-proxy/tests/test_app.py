import json, httpx, pytest
from fastapi.testclient import TestClient
from seatproxy.store import SeatStore
from seatproxy.app import create_app

def build(tmp_path, handler=None):
    handler = handler or (lambda r: httpx.Response(200, json={}))
    store = SeatStore(str(tmp_path / "s.db"))
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app = create_app(store, client, str(tmp_path / "state"))
    return store, TestClient(app)

def test_enroll_start_requires_owner_header(tmp_path):
    _, app = build(tmp_path)
    assert app.post("/enroll/anthropic/start").status_code == 400

def test_enroll_start_rejects_unknown_provider(tmp_path):
    _, app = build(tmp_path)
    r = app.post("/enroll/bogus/start", headers={"X-Seat-Owner": "alice"})
    assert r.status_code == 400

def test_enroll_start_returns_the_login_command(tmp_path):
    _, app = build(tmp_path)
    r = app.post("/enroll/anthropic/start", headers={"X-Seat-Owner": "alice"})
    assert r.status_code == 200
    body = r.json()
    assert "CLAUDE_CONFIG_DIR=" in body["command"]
    assert body["command"].endswith("claude login")
    assert body["poll_id"]

def test_poll_reports_pending_until_credentials_appear(tmp_path):
    _, app = build(tmp_path)
    start = app.post("/enroll/anthropic/start",
                     headers={"X-Seat-Owner": "alice"}).json()
    r = app.post("/enroll/anthropic/poll", json={"poll_id": start["poll_id"]})
    assert r.json()["status"] == "pending"

def test_poll_completes_once_credentials_exist(tmp_path):
    _, app = build(tmp_path)
    start = app.post("/enroll/anthropic/start",
                     headers={"X-Seat-Owner": "alice"}).json()
    cfg = tmp_path / "state" / "alice" / "anthropic"
    (cfg / ".credentials.json").write_text(json.dumps(
        {"claudeAiOauth": {"accessToken": "A", "refreshToken": "R",
                           "expiresAt": 9_000_000}}), encoding="utf-8")
    body = app.post("/enroll/anthropic/poll",
                    json={"poll_id": start["poll_id"]}).json()
    assert body["status"] == "complete"
    assert body["handle"]
    assert "claude-sonnet-5" in body["models"]

def test_delete_rejects_another_owners_handle(tmp_path):
    store, app = build(tmp_path)
    h = store.put("alice", "anthropic", str(tmp_path / "cfg"))
    assert app.delete(f"/enroll/{h}",
                      headers={"X-Seat-Owner": "mallory"}).status_code == 404
    assert store.get(h) is not None

def test_delete_revokes_own_handle(tmp_path):
    store, app = build(tmp_path)
    h = store.put("alice", "anthropic", str(tmp_path / "cfg"))
    assert app.delete(f"/enroll/{h}",
                      headers={"X-Seat-Owner": "alice"}).status_code == 204
    assert store.get(h) is None

def test_relay_route_does_not_forward_its_prefix(tmp_path):
    # relay() sends with stream=True and reads via aiter_raw(); a plain
    # httpx.Response(json=...) is eagerly marked is_stream_consumed=True at
    # construction, so aiter_raw() raises StreamConsumed on it. A lazy
    # AsyncByteStream (same pattern as tests/test_relay.py's _Stream) avoids that.
    class _Stream(httpx.AsyncByteStream):
        def __init__(self, chunks):
            self._chunks = chunks
        async def __aiter__(self):
            for c in self._chunks:
                yield c

    seen = {}
    def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, headers={"content-type": "application/json"},
                              stream=_Stream([b'{"ok": true}']))
    store, app = build(tmp_path, handler)
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    (cfg / ".credentials.json").write_text(json.dumps(
        {"claudeAiOauth": {"accessToken": "A", "refreshToken": "R",
                           "expiresAt": 99_999_999_999_000}}), encoding="utf-8")
    h = store.put("alice", "anthropic", str(cfg))
    app.post("/anthropic/v1/messages", headers={"x-api-key": h}, json={})
    assert seen["url"] == "https://api.anthropic.com/v1/messages"

@pytest.mark.parametrize("bad", ["../evil", "..", ".", "a/b", "a\\b", "x" * 65,
                                 "../../etc/passwd"])
def test_enroll_start_rejects_unsafe_owner(tmp_path, bad):
    _, app = build(tmp_path)
    r = app.post("/enroll/anthropic/start", headers={"X-Seat-Owner": bad})
    assert r.status_code == 400

def test_traversal_owner_creates_nothing_outside_state_dir(tmp_path):
    _, app = build(tmp_path)
    app.post("/enroll/anthropic/start", headers={"X-Seat-Owner": "../escaped"})
    assert not (tmp_path / "escaped").exists()
    assert not (tmp_path.parent / "escaped").exists()

@pytest.mark.parametrize("bad", ["alice.", ".alice", "alice ", "con", "CON",
                                 "nul", "com1", "lpt9", "alice..bob"])
def test_enroll_start_rejects_aliasing_and_reserved_owners(tmp_path, bad):
    _, app = build(tmp_path)
    r = app.post("/enroll/anthropic/start", headers={"X-Seat-Owner": bad})
    assert r.status_code == 400

def test_trailing_dot_owner_cannot_reach_another_users_directory(tmp_path):
    # Windows strips trailing dots from a path component, so "alice." and "alice"
    # are the same directory. It must be rejected outright, never aliased.
    _, app = build(tmp_path)
    assert app.post("/enroll/anthropic/start",
                    headers={"X-Seat-Owner": "alice"}).status_code == 200
    assert app.post("/enroll/anthropic/start",
                    headers={"X-Seat-Owner": "alice."}).status_code == 400
    assert sorted(p.name for p in (tmp_path / "state").iterdir()) == ["alice"]

@pytest.mark.parametrize("bad", ["Alice", "ALICE", "aLiCe", "Bob.Smith"])
def test_enroll_start_rejects_non_casefolded_owner(tmp_path, bad):
    _, app = build(tmp_path)
    r = app.post("/enroll/anthropic/start", headers={"X-Seat-Owner": bad})
    assert r.status_code == 400

def test_mixed_case_owner_cannot_reach_another_users_directory(tmp_path):
    _, app = build(tmp_path)
    assert app.post("/enroll/anthropic/start",
                    headers={"X-Seat-Owner": "alice"}).status_code == 200
    assert app.post("/enroll/anthropic/start",
                    headers={"X-Seat-Owner": "Alice"}).status_code == 400
