import json, os, pytest
from seatproxy.credentials import (
    SeatTokens, CredentialsMissing, CredentialsMalformed,
    read_tokens, write_tokens, credentials_path)

def write_claude(dirpath, access="A", refresh="R", expires_ms=9_000_000, extra=None):
    doc = {"claudeAiOauth": {"accessToken": access, "refreshToken": refresh,
                             "expiresAt": expires_ms}}
    if extra:
        doc.update(extra)
    (dirpath / ".credentials.json").write_text(json.dumps(doc), encoding="utf-8")

def test_reads_claude_and_converts_ms_to_seconds(tmp_path):
    write_claude(tmp_path, expires_ms=9_000_000)
    t = read_tokens("anthropic", str(tmp_path))
    assert (t.access_token, t.refresh_token) == ("A", "R")
    assert t.expires_at == 9000.0

def test_reads_codex_nested_tokens(tmp_path):
    (tmp_path / "auth.json").write_text(json.dumps(
        {"tokens": {"access_token": "A", "refresh_token": "R"}, "expires_at": 1234.0}),
        encoding="utf-8")
    t = read_tokens("openai", str(tmp_path))
    assert (t.access_token, t.refresh_token, t.expires_at) == ("A", "R", 1234.0)

def test_missing_file_raises_credentials_missing(tmp_path):
    with pytest.raises(CredentialsMissing):
        read_tokens("anthropic", str(tmp_path))

def test_unparseable_file_raises_malformed(tmp_path):
    (tmp_path / ".credentials.json").write_text("not json", encoding="utf-8")
    with pytest.raises(CredentialsMalformed):
        read_tokens("anthropic", str(tmp_path))

def test_missing_fields_raise_malformed(tmp_path):
    (tmp_path / ".credentials.json").write_text(
        json.dumps({"claudeAiOauth": {"accessToken": "A"}}), encoding="utf-8")
    with pytest.raises(CredentialsMalformed):
        read_tokens("anthropic", str(tmp_path))

def test_repr_redacts_tokens():
    t = SeatTokens("SECRET-ACCESS", "SECRET-REFRESH", 1.0)
    text = repr(t)
    assert "SECRET-ACCESS" not in text and "SECRET-REFRESH" not in text
    assert "redacted" in text

def test_exceptions_carry_no_path_or_token(tmp_path):
    with pytest.raises(CredentialsMissing) as exc:
        read_tokens("anthropic", str(tmp_path))
    assert str(tmp_path) not in str(exc.value)

def test_write_back_preserves_unrelated_fields_and_rewrites_ms(tmp_path):
    write_claude(tmp_path, extra={"subscriptionType": "max", "scopes": ["a"]})
    write_tokens("anthropic", str(tmp_path), SeatTokens("NEW", "NEWR", 5000.0))
    doc = json.loads((tmp_path / ".credentials.json").read_text(encoding="utf-8"))
    assert doc["claudeAiOauth"]["accessToken"] == "NEW"
    assert doc["claudeAiOauth"]["expiresAt"] == 5_000_000
    assert doc["subscriptionType"] == "max"
    assert doc["scopes"] == ["a"]

def test_write_is_atomic_and_leaves_no_temp_file(tmp_path):
    write_claude(tmp_path)
    write_tokens("anthropic", str(tmp_path), SeatTokens("NEW", "NEWR", 5000.0))
    assert [p.name for p in tmp_path.iterdir()] == [".credentials.json"]

def test_credentials_path_uses_provider_filename(tmp_path):
    assert credentials_path("anthropic", str(tmp_path)).name == ".credentials.json"
    assert credentials_path("openai", str(tmp_path)).name == "auth.json"

@pytest.mark.skipif(os.name == "nt",
                    reason="POSIX file modes are not enforced on Windows")
def test_written_credentials_are_owner_only(tmp_path):
    # os.replace makes the destination inherit the temp file's mode, so a
    # default-mode temp would downgrade the user's credentials to world-readable.
    write_claude(tmp_path)
    write_tokens("anthropic", str(tmp_path), SeatTokens("NEW", "NEWR", 5000.0))
    assert (tmp_path / ".credentials.json").stat().st_mode & 0o777 == 0o600
