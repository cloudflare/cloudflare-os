# seat-proxy/main.py
import os
import sys
from pathlib import Path

# The seatproxy package lives under src/ (src layout, same as pytest.ini's
# `pythonpath = src`). There is no installed package or venv, so the entrypoint
# has to put src/ on sys.path itself before it can import seatproxy.*.
sys.path.insert(0, str(Path(__file__).parent / "src"))

import httpx
import uvicorn

from seatproxy.app import create_app
from seatproxy.store import SeatStore

STATE_DIR = os.environ.get("SEAT_PROXY_STATE", "state")
DB_PATH = os.environ.get("SEAT_PROXY_DB", "seats.db")
PORT = int(os.environ.get("SEAT_PROXY_PORT", "8890"))

# A DB or state path whose parent directory does not exist yet (first run) would
# otherwise die with a raw sqlite3.OperationalError before create_app even runs.
Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
Path(STATE_DIR).mkdir(parents=True, exist_ok=True)

# 600s read timeout: a long completion must not be cut off mid-stream.
app = create_app(SeatStore(DB_PATH),
                 httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0)),
                 STATE_DIR)

if __name__ == "__main__":
    # Bind loopback only: this service holds every enrolled user's refresh tokens
    # and has no authentication of its own beyond the handle.
    uvicorn.run(app, host="127.0.0.1", port=PORT)
