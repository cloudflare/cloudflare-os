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

# test_enroll_start_returns_the_login_command (old CLI-command contract) is not
# translated: test_anthropic_start_returns_an_authorize_url below exercises the
# exact same scenario (alice, anthropic, /start) under the new contract, so a
# translation would be a verbatim duplicate rather than added coverage.

def test_openai_complete_reports_pending_until_authorized(tmp_path):
    # Translates test_poll_reports_pending_until_credentials_appear: Anthropic no
    # longer has a poll endpoint, but OpenAI's device flow polls the same way via
    # repeated /complete calls, returning "pending" until the user authorizes.
    def handler(request):
        if str(request.url).endswith("/oauth/device/code"):
            return httpx.Response(200, json={"device_code": "DC", "user_code": "ABCD-1234",
                                             "verification_uri_complete": "https://x/y",
                                             "interval": 5})
        return httpx.Response(400, json={"error": "authorization_pending"})
    _, app = build(tmp_path, handler)
    start = app.post("/enroll/openai/start", headers={"X-Seat-Owner": "alice"}).json()
    body = app.post("/enroll/openai/complete",
                    json={"enroll_id": start["enroll_id"]}).json()
    assert body["status"] == "pending"

def test_openai_complete_mints_a_handle_once_authorized(tmp_path):
    # Translates test_poll_completes_once_credentials_exist: the old test wrote
    # credentials directly (as if the CLI login had finished) and polled to pick
    # them up. Under OAuth there is no external process writing the file, so the
    # equivalent is the device flow's token endpoint succeeding once authorized.
    def handler(request):
        if str(request.url).endswith("/oauth/device/code"):
            return httpx.Response(200, json={"device_code": "DC", "user_code": "ABCD-1234",
                                             "verification_uri_complete": "https://x/y",
                                             "interval": 5})
        return httpx.Response(200, json={"access_token": "A", "refresh_token": "R",
                                         "expires_in": 3600})
    store, app = build(tmp_path, handler)
    start = app.post("/enroll/openai/start", headers={"X-Seat-Owner": "alice"}).json()
    body = app.post("/enroll/openai/complete",
                    json={"enroll_id": start["enroll_id"]}).json()
    assert body["status"] == "complete"
    rec = store.get(body["handle"])
    assert rec.owner == "alice" and rec.provider == "openai"

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

def test_anthropic_start_returns_an_authorize_url(tmp_path):
    _, app = build(tmp_path)
    body = app.post("/enroll/anthropic/start",
                    headers={"X-Seat-Owner": "alice"}).json()
    assert body["kind"] == "authorize_url"
    assert body["url"].startswith("https://claude.com/cai/oauth/authorize?")
    assert body["enroll_id"]
    assert "verifier" not in str(body)        # the verifier must stay server-side

def test_complete_rejects_unknown_enroll_id(tmp_path):
    _, app = build(tmp_path)
    r = app.post("/enroll/anthropic/complete",
                 json={"enroll_id": "nope", "code": "x"})
    assert r.status_code == 404

def test_anthropic_complete_exchanges_and_mints_a_handle(tmp_path):
    def handler(request):
        return httpx.Response(200, json={"access_token": "A", "refresh_token": "R",
                                         "expires_in": 3600})
    store, app = build(tmp_path, handler)
    start = app.post("/enroll/anthropic/start",
                     headers={"X-Seat-Owner": "alice"}).json()
    body = app.post("/enroll/anthropic/complete",
                    json={"enroll_id": start["enroll_id"], "code": "THECODE"}).json()
    assert body["status"] == "complete"
    rec = store.get(body["handle"])
    assert rec.owner == "alice" and rec.provider == "anthropic"
    creds = json.loads(
        (tmp_path / "state" / "alice" / "anthropic" / ".credentials.json")
        .read_text(encoding="utf-8"))
    assert creds["claudeAiOauth"]["accessToken"] == "A"

def test_complete_is_single_use(tmp_path):
    def handler(request):
        return httpx.Response(200, json={"access_token": "A", "refresh_token": "R",
                                         "expires_in": 3600})
    _, app = build(tmp_path, handler)
    start = app.post("/enroll/anthropic/start",
                     headers={"X-Seat-Owner": "alice"}).json()
    payload = {"enroll_id": start["enroll_id"], "code": "THECODE"}
    assert app.post("/enroll/anthropic/complete", json=payload).json()["status"] == "complete"
    assert app.post("/enroll/anthropic/complete", json=payload).status_code == 404

def test_rejected_code_returns_401_not_500(tmp_path):
    def handler(request):
        return httpx.Response(400, json={"error": "invalid_grant"})
    _, app = build(tmp_path, handler)
    start = app.post("/enroll/anthropic/start",
                     headers={"X-Seat-Owner": "alice"}).json()
    r = app.post("/enroll/anthropic/complete",
                 json={"enroll_id": start["enroll_id"], "code": "BAD"})
    assert r.status_code == 401
    assert "detail" not in r.json()

def test_openai_start_returns_a_device_code(tmp_path):
    def handler(request):
        return httpx.Response(200, json={"device_code": "DC", "user_code": "ABCD-1234",
                                         "verification_uri_complete": "https://x/y",
                                         "interval": 5})
    _, app = build(tmp_path, handler)
    body = app.post("/enroll/openai/start", headers={"X-Seat-Owner": "alice"}).json()
    assert body["kind"] == "device_code"
    assert body["user_code"] == "ABCD-1234"
    assert "device_code" not in body          # server-side only

def test_complete_with_non_string_enroll_id_returns_provider_error(tmp_path):
    _, app = build(tmp_path)
    r = app.post("/enroll/anthropic/complete", json={"enroll_id": {}, "code": "x"})
    assert r.status_code == 404
    assert "detail" not in r.json()

def test_credentials_write_failure_returns_provider_error_not_a_traceback(tmp_path,
                                                                          monkeypatch):
    def handler(request):
        return httpx.Response(200, json={"access_token": "A", "refresh_token": "R",
                                         "expires_in": 3600})
    _, app = build(tmp_path, handler)
    start = app.post("/enroll/anthropic/start",
                     headers={"X-Seat-Owner": "alice"}).json()
    from seatproxy import app as app_mod
    def boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(app_mod, "create_tokens", boom)
    r = app.post("/enroll/anthropic/complete",
                 json={"enroll_id": start["enroll_id"], "code": "C"})
    assert r.status_code == 502
    body = r.json()
    assert "detail" not in body
    assert "disk full" not in str(body)
