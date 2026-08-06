import sqlite3
from cryptography.fernet import Fernet
from seatproxy.store import TokenStore

def test_roundtrip_and_tokens_encrypted_at_rest(tmp_path):
    db = str(tmp_path / "s.db")
    store = TokenStore(db, Fernet.generate_key())
    handle = store.put("alice", "anthropic", "ACCESS-SECRET", "REFRESH-SECRET", 1000.0)

    rec = store.get(handle)
    assert rec.owner == "alice"
    assert rec.access_token == "ACCESS-SECRET"
    assert rec.needs_reauth is False

    raw = sqlite3.connect(db).execute("select * from seats").fetchone()
    assert "ACCESS-SECRET" not in str(raw)

def test_handles_are_unique_and_opaque(tmp_path):
    store = TokenStore(str(tmp_path / "s.db"), Fernet.generate_key())
    a = store.put("alice", "anthropic", "x", "y", 1.0)
    b = store.put("alice", "anthropic", "x", "y", 1.0)
    assert a != b and len(a) >= 32 and "alice" not in a

def test_get_unknown_handle_returns_none(tmp_path):
    store = TokenStore(str(tmp_path / "s.db"), Fernet.generate_key())
    assert store.get("nope") is None

def test_mark_needs_reauth_and_delete(tmp_path):
    store = TokenStore(str(tmp_path / "s.db"), Fernet.generate_key())
    h = store.put("bob", "openai", "a", "r", 5.0)
    store.mark_needs_reauth(h)
    assert store.get(h).needs_reauth is True
    store.delete(h)
    assert store.get(h) is None
