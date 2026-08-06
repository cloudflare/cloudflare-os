from seatproxy.store import SeatStore

def test_put_and_get_roundtrip(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = store.put("alice", "anthropic", "/seats/alice/anthropic")
    rec = store.get(h)
    assert rec.owner == "alice"
    assert rec.provider == "anthropic"
    assert rec.config_dir == "/seats/alice/anthropic"
    assert rec.needs_reauth is False

def test_no_token_columns_exist(tmp_path):
    # The CLI credentials file is authoritative; the store must never hold tokens.
    import sqlite3
    db = str(tmp_path / "s.db")
    SeatStore(db).put("alice", "anthropic", "/d")
    cols = {r[1] for r in sqlite3.connect(db).execute("pragma table_info(seats)")}
    assert not cols & {"access", "refresh", "access_token", "refresh_token"}

def test_handles_are_unique_and_opaque(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    a = store.put("alice", "anthropic", "/d")
    b = store.put("alice", "anthropic", "/d")
    assert a != b and len(a) >= 32 and "alice" not in a

def test_get_unknown_handle_returns_none(tmp_path):
    assert SeatStore(str(tmp_path / "s.db")).get("nope") is None

def test_find_by_owner_and_provider(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = store.put("alice", "anthropic", "/d")
    assert store.find("alice", "anthropic").handle == h
    assert store.find("alice", "openai") is None
    assert store.find("bob", "anthropic") is None

def test_needs_reauth_can_be_set_and_cleared(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = store.put("alice", "anthropic", "/d")
    store.mark_needs_reauth(h)
    assert store.get(h).needs_reauth is True
    store.clear_needs_reauth(h)
    assert store.get(h).needs_reauth is False

def test_delete_removes_the_mapping(tmp_path):
    store = SeatStore(str(tmp_path / "s.db"))
    h = store.put("alice", "anthropic", "/d")
    store.delete(h)
    assert store.get(h) is None
