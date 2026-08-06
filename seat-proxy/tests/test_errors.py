import json
from seatproxy.errors import provider_error

def test_anthropic_error_shape():
    r = provider_error("anthropic", 401, "authentication_error", "reconnect your seat")
    body = json.loads(r.body)
    assert r.status_code == 401
    assert body == {"type": "error",
                    "error": {"type": "authentication_error", "message": "reconnect your seat"}}

def test_openai_error_shape():
    r = provider_error("openai", 401, "invalid_request_error", "reconnect your seat")
    body = json.loads(r.body)
    assert r.status_code == 401
    assert body["error"]["message"] == "reconnect your seat"
    assert body["error"]["type"] == "invalid_request_error"
    assert body["error"]["code"] is None
    assert body["error"]["param"] is None
    assert "detail" not in body
