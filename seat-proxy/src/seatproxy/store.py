"""Handle -> seat routing map.

Holds no tokens: the provider CLI's credentials file inside `config_dir` is
authoritative. `config_dir` is also the seam that lets this later split into
one worker process per user without changing callers.
"""

import secrets
import sqlite3
from contextlib import closing
from dataclasses import dataclass

@dataclass
class Record:
    handle: str
    owner: str
    provider: str
    config_dir: str
    needs_reauth: bool

_COLUMNS = "handle,owner,provider,config_dir,needs_reauth"

class SeatStore:
    def __init__(self, db_path: str):
        self._db_path = db_path
        with self._conn() as c:
            c.execute("""create table if not exists seats (
                handle text primary key, owner text not null, provider text not null,
                config_dir text not null, needs_reauth integer not null default 0)""")

    def _conn(self):
        # closing() actually closes the handle; a bare `with sqlite3.connect(...)`
        # only ends the transaction. isolation_level=None means autocommit.
        return closing(sqlite3.connect(self._db_path, isolation_level=None))

    def _row_to_record(self, row):
        if row is None:
            return None
        return Record(row[0], row[1], row[2], row[3], bool(row[4]))

    def put(self, owner: str, provider: str, config_dir: str) -> str:
        handle = secrets.token_urlsafe(32)
        with self._conn() as c:
            c.execute("insert into seats values (?,?,?,?,0)",
                      (handle, owner, provider, config_dir))
        return handle

    def get(self, handle: str):
        with self._conn() as c:
            row = c.execute(f"select {_COLUMNS} from seats where handle=?",
                            (handle,)).fetchone()
        return self._row_to_record(row)

    def find(self, owner: str, provider: str):
        with self._conn() as c:
            row = c.execute(f"select {_COLUMNS} from seats where owner=? and provider=?",
                            (owner, provider)).fetchone()
        return self._row_to_record(row)

    def mark_needs_reauth(self, handle: str) -> None:
        with self._conn() as c:
            c.execute("update seats set needs_reauth=1 where handle=?", (handle,))

    def clear_needs_reauth(self, handle: str) -> None:
        with self._conn() as c:
            c.execute("update seats set needs_reauth=0 where handle=?", (handle,))

    def delete(self, handle: str) -> None:
        with self._conn() as c:
            c.execute("delete from seats where handle=?", (handle,))
