import secrets, sqlite3
from dataclasses import dataclass
from cryptography.fernet import Fernet

@dataclass
class Record:
    handle: str
    owner: str
    provider: str
    access_token: str
    refresh_token: str
    expires_at: float
    needs_reauth: bool

class TokenStore:
    def __init__(self, db_path: str, fernet_key: bytes):
        self._db_path = db_path
        self._f = Fernet(fernet_key)
        with self._conn() as c:
            c.execute("""create table if not exists seats (
                handle text primary key, owner text not null, provider text not null,
                access blob not null, refresh blob not null,
                expires_at real not null, needs_reauth integer not null default 0)""")

    def _conn(self):
        return sqlite3.connect(self._db_path, isolation_level=None)

    def put(self, owner, provider, access, refresh, expires_at) -> str:
        handle = secrets.token_urlsafe(32)
        with self._conn() as c:
            c.execute("insert into seats values (?,?,?,?,?,?,0)",
                      (handle, owner, provider, self._f.encrypt(access.encode()),
                       self._f.encrypt(refresh.encode()), expires_at))
        return handle

    def get(self, handle):
        row = self._conn().execute(
            "select handle,owner,provider,access,refresh,expires_at,needs_reauth "
            "from seats where handle=?", (handle,)).fetchone()
        if row is None:
            return None
        return Record(row[0], row[1], row[2], self._f.decrypt(row[3]).decode(),
                      self._f.decrypt(row[4]).decode(), row[5], bool(row[6]))

    def update_tokens(self, handle, access, refresh, expires_at):
        with self._conn() as c:
            c.execute("update seats set access=?,refresh=?,expires_at=?,needs_reauth=0 "
                      "where handle=?", (self._f.encrypt(access.encode()),
                                         self._f.encrypt(refresh.encode()), expires_at, handle))

    def mark_needs_reauth(self, handle):
        with self._conn() as c:
            c.execute("update seats set needs_reauth=1 where handle=?", (handle,))

    def delete(self, handle):
        with self._conn() as c:
            c.execute("delete from seats where handle=?", (handle,))
