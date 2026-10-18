"""
Read-only IMDb search + SQL console for an imdb-sqlite database.
HTML lives in templates/, CSS/JS in static/.

Normally run via Docker (see docker-compose.yml). Without Docker:
    python app.py --build-search        # once: builds the FTS title index
    gunicorn -w 1 --threads 4 -b 127.0.0.1:8000 app:app
"""

import os
import re
import json
import logging
import sqlite3
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request
from flask_limiter import Limiter

DB_PATH = os.environ.get("IMDB_DB", "imdb.db")
# The DB is static while served, so open it immutable: no locks, and it works
# on a read-only mount. Restart the app after replacing the file.
IMMUTABLE = os.environ.get("IMDB_IMMUTABLE", "1") == "1"


def ro_uri():
    uri = Path(DB_PATH).resolve().as_uri() + "?mode=ro"
    return uri + "&immutable=1" if IMMUTABLE else uri


app = Flask(__name__)


def client_ip():
    return request.headers.get("X-Real-IP") or request.remote_addr


limiter = Limiter(
    key_func=client_ip,
    app=app,
    default_limits=["60 per minute"],
    storage_uri="memory://",
)

access_logger = logging.getLogger("imdb.access")
access_logger.setLevel(logging.INFO)
access_logger.propagate = False
if not access_logger.handlers:
    access_handler = logging.StreamHandler(sys.stdout)
    access_handler.setFormatter(logging.Formatter("%(message)s"))
    access_logger.addHandler(access_handler)


@app.before_request
def start_access_log():
    request_id = request.headers.get("X-Request-ID", "")
    g.request_id = (
        request_id if re.fullmatch(r"[0-9a-f]{32}", request_id) else uuid.uuid4().hex
    )
    g.request_started_at = time.monotonic()


@app.after_request
def write_access_log(response):
    request_id = getattr(g, "request_id", uuid.uuid4().hex)
    response.headers["X-Request-ID"] = request_id
    if request.path != "/healthz":
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "request_id": request_id,
            "client_ip": (client_ip() or "")[:64],
            "method": request.method,
            "path": request.path,
            "status": response.status_code,
            "duration_ms": round((time.monotonic() - g.request_started_at) * 1000),
            "response_bytes": response.content_length,
            "user_agent": request.headers.get("User-Agent", "")[:256],
        }
        access_logger.info(json.dumps(entry, separators=(",", ":"), ensure_ascii=True))
    return response


# Views that give a pyimdb.py-style database (title_basics, title_ratings, ...)
# the same table/column names that imdb-sqlite uses, so the app has one schema.
COMPAT_VIEWS = """
CREATE VIEW titles AS SELECT
    tconst AS title_id, titleType AS type, primaryTitle AS primary_title,
    originalTitle AS original_title, isAdult AS is_adult, startYear AS premiered,
    endYear AS ended, runtimeMinutes AS runtime_minutes, genres
FROM title_basics;
CREATE VIEW ratings AS SELECT
    tconst AS title_id, averageRating AS rating, numVotes AS votes
FROM title_ratings;
CREATE VIEW people AS SELECT
    nconst AS person_id, primaryName AS name, birthYear AS born, deathYear AS died
FROM name_basics;
CREATE VIEW crew AS SELECT
    tconst AS title_id, nconst AS person_id, category, job, characters
FROM title_principals;
"""


def ensure_schema(conn):
    """Make sure titles/ratings/people/crew exist (create views for pyimdb.py DBs)."""
    have = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
        )
    }
    need = {"titles", "ratings", "people", "crew"}
    if need <= have:
        return
    raw = {"title_basics", "title_ratings", "name_basics", "title_principals"}
    if raw <= have:
        print("Found pyimdb.py-style tables; creating compatibility views...")
        for name in need & have:  # leftovers from a partial earlier run
            conn.execute(f"DROP VIEW IF EXISTS {name}")
        conn.executescript(COMPAT_VIEWS)
        return
    sys.exit(
        f"{DB_PATH} doesn't have the expected tables.\n"
        f"  Tables found: {', '.join(sorted(have)) or '(none)'}\n"
        "  Need either imdb-sqlite's (titles, ratings, people, crew) or\n"
        "  pyimdb.py's (title_basics, title_ratings, name_basics, title_principals)."
    )


def build_search():
    """Create an FTS5 index of titles that have ratings (keeps it small and relevant)."""
    if not Path(DB_PATH).is_file():
        # sqlite3.connect would silently create an empty DB here
        sys.exit(f"Database not found: {DB_PATH}")
    # File mtime before we touch it = when the import finished (rename keeps mtime)
    imported_fallback = iso(Path(DB_PATH).stat().st_mtime)
    conn = sqlite3.connect(DB_PATH)
    ensure_schema(conn)
    conn.executescript(
        """
        DROP TABLE IF EXISTS title_fts;
        CREATE VIRTUAL TABLE title_fts USING fts5(
            primary_title, title_id UNINDEXED, votes UNINDEXED,
            tokenize = 'unicode61 remove_diacritics 2'
        );
        INSERT INTO title_fts (primary_title, title_id, votes)
            SELECT t.primary_title, t.title_id, r.votes
            FROM titles t JOIN ratings r ON r.title_id = t.title_id;
        """
    )
    conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    # imported_at is kept across re-indexing; a fresh import has no meta table yet
    conn.execute(
        "INSERT OR IGNORE INTO meta VALUES ('imported_at', ?)", (imported_fallback,)
    )
    conn.execute(
        "INSERT OR REPLACE INTO meta VALUES ('indexed_at', ?)", (iso(time.time()),)
    )
    conn.commit()
    conn.close()
    print("Search index built.")


def db():
    if "db" not in g:
        # Read-only: even a bug can't modify or damage the data
        g.db = sqlite3.connect(ro_uri(), uri=True)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


@app.get("/api/search")
def search():
    tokens = re.findall(r"\w+", request.args.get("q", ""))[:6]
    if not tokens:
        return jsonify([])
    match = " ".join(f'"{t}"*' for t in tokens)  # safe: only \w chars inside quotes
    d = db()
    title = d.execute(
        """
        SELECT t.title_id, t.primary_title, t.type, t.premiered, r.rating, r.votes
        FROM title_fts f
        JOIN titles t ON t.title_id = f.title_id
        LEFT JOIN ratings r ON r.title_id = t.title_id
        WHERE title_fts MATCH ?
        ORDER BY CAST(f.votes AS INTEGER) DESC
        LIMIT 25
        """,
        (match,),
    ).fetchall()
    return jsonify([dict(row) for row in title])


@app.get("/api/title/<title_id>")
def title(title_id):
    d = db()
    title_row = d.execute(
        """
        SELECT t.*, r.rating, r.votes FROM titles t
        LEFT JOIN ratings r ON r.title_id = t.title_id
        WHERE t.title_id = ?
        """,
        (title_id,),
    ).fetchone()
    if not title_row:
        return jsonify(error="not found"), 404
    cast = d.execute(
        """
        SELECT p.person_id, p.name, c.category, c.characters
        FROM crew c JOIN people p ON p.person_id = c.person_id
        WHERE c.title_id = ? LIMIT 30
        """,
        (title_id,),
    ).fetchall()
    return jsonify(title=dict(title_row), cast=[dict(person) for person in cast])


@app.get("/api/person/<person_id>")
def person(person_id):
    d = db()
    person = d.execute(
        "SELECT * FROM people WHERE person_id = ?", (person_id,)
    ).fetchone()
    if not person:
        return jsonify(error="not found"), 404
    titles = d.execute(
        """
        SELECT t.title_id, t.primary_title, t.type, t.premiered,
               c.category, r.rating, r.votes
        FROM crew c
        JOIN titles t ON t.title_id = c.title_id
        LEFT JOIN ratings r ON r.title_id = t.title_id
        WHERE c.person_id = ?
        ORDER BY r.votes DESC LIMIT 40
        """,
        (person_id,),
    ).fetchall()
    return jsonify(person=dict(person), titles=[dict(title) for title in titles])


# ---------------------------------------------------------------------------
# Public SQL console
#
# Layers of protection:
#   1. Read-only connection + PRAGMA query_only + authorizer (SELECT only)
#   2. Hard time limit per query (progress handler aborts it)
#   3. Row / cell / SQL-length caps
#   4. Per-IP "load budget": every query costs its real execution time (seconds)
#      from a bucket that refills over time -> cheap queries are nearly free,
#      heavy ones drain the budget fast
#   5. Request-count limit per IP (flask-limiter) and a global concurrency cap
#
# NOTE: budgets live in process memory, so run gunicorn with ONE worker and
# several threads:  gunicorn -w 1 --threads 4 -b 127.0.0.1:8000 app:app
# ---------------------------------------------------------------------------
MAX_SQL_LEN = 2000
MAX_ROWS = 500
MAX_CELL = 300
MAX_SECONDS = 5.0  # hard limit for one query
BUCKET_CAPACITY = 30.0  # seconds of query time an IP can bank
BUCKET_REFILL = 0.5  # seconds of query time regained per real second
MIN_CHARGE = 0.05  # every query costs at least this much
MAX_CONCURRENT = 4  # queries running at once

slots = threading.BoundedSemaphore(MAX_CONCURRENT)
buckets = {}  # ip -> (tokens, last_update)
buckets_lock = threading.Lock()
BLOCKED_FUNCS = {
    "load_extension",
    "randomblob",
    "zeroblob",
    "readfile",
    "writefile",
    "edit",
    "fts3_tokenizer",
}


class QueryError(Exception):
    pass


def bucket_tokens(ip):
    """Refill and return an IP's remaining budget. Call with buckets_lock held."""
    now = time.monotonic()
    tokens, last = buckets.get(ip, (BUCKET_CAPACITY, now))
    tokens = min(BUCKET_CAPACITY, tokens + (now - last) * BUCKET_REFILL)
    buckets[ip] = (tokens, now)
    if len(buckets) > 10000:  # prune idle entries
        for k, (_, t) in list(buckets.items()):
            if now - t > 600:
                del buckets[k]
    return tokens


def authorizer(action, arg1, arg2, dbname, source):
    if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_RECURSIVE):
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_FUNCTION and (arg2 or "").lower() not in BLOCKED_FUNCS:
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY  # PRAGMA, ATTACH, INSERT, DROP, ... all denied


def cell(v):
    if isinstance(v, bytes):
        return f"<blob {len(v)} bytes>"
    if isinstance(v, str) and len(v) > MAX_CELL:
        return v[:MAX_CELL] + "…"
    return v


def run_user_query(sql):
    conn = sqlite3.connect(ro_uri(), uri=True)
    try:
        # PRAGMAs must run before the authorizer is installed
        conn.execute("PRAGMA query_only = ON")
        conn.execute("PRAGMA cache_size = -20000")  # ~20 MB page cache
        conn.set_authorizer(authorizer)
        if hasattr(conn, "setlimit"):  # Python 3.11+
            conn.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 1_000_000)
            conn.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, MAX_SQL_LEN)

        deadline = time.monotonic() + MAX_SECONDS
        timed_out = []

        def check():
            if time.monotonic() > deadline:
                timed_out.append(1)
                return 1  # abort
            return 0

        conn.set_progress_handler(check, 20000)
        try:
            cur = conn.execute(sql)
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = []
            truncated = False
            for row in cur:
                if len(rows) == MAX_ROWS:
                    truncated = True
                    break
                rows.append([cell(v) for v in row])
        except (sqlite3.Error, sqlite3.Warning) as e:
            if timed_out:
                raise QueryError(
                    f"Query exceeded the {MAX_SECONDS:.0f}s limit. "
                    "Add filters/LIMIT or use indexed columns."
                )
            raise QueryError(str(e))
        return {"columns": cols, "rows": rows, "truncated": truncated}
    finally:
        conn.close()


@app.post("/api/query")
@limiter.limit("12 per minute")
def user_query():
    sql = ((request.get_json(silent=True) or {}).get("sql") or "").strip().rstrip(";")
    if not sql:
        return jsonify(error="Empty query."), 400
    if len(sql) > MAX_SQL_LEN:
        return jsonify(error=f"Query too long (max {MAX_SQL_LEN} chars)."), 400

    ip = client_ip()
    with buckets_lock:
        tokens = bucket_tokens(ip)
    if tokens < 1.0:
        wait = int((1.0 - tokens) / BUCKET_REFILL) + 1
        resp = jsonify(error=f"Query budget used up. Try again in about {wait}s.")
        resp.status_code = 429
        resp.headers["Retry-After"] = str(wait)
        return resp

    if not slots.acquire(timeout=2):
        return jsonify(error="Server is busy, try again shortly."), 503

    start = time.monotonic()
    result, error = None, None
    try:
        result = run_user_query(sql)
    except QueryError as e:
        error = str(e)
    finally:
        slots.release()
        elapsed = time.monotonic() - start
        with buckets_lock:
            tokens = bucket_tokens(ip) - max(MIN_CHARGE, elapsed)
            buckets[ip] = (tokens, time.monotonic())

    meta = {
        "ms": round(elapsed * 1000),
        "budget_left": round(max(tokens, 0), 1),
        "budget_max": BUCKET_CAPACITY,
    }
    if error:
        return jsonify(error=error, **meta), 400
    return jsonify(**result, **meta)


_schema_cache = {}


@app.get("/api/schema")
def schema():
    """Tables/views with column types. Metadata only: costs nothing from the query budget."""
    if "objects" not in _schema_cache:
        d = db()
        rows = d.execute(
            "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') "
            "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'title_fts%' AND name <> 'meta' "
            "ORDER BY name"
        ).fetchall()
        objects = []
        for name, kind in rows:
            cols = [
                {"name": c["name"], "type": c["type"] or ""}
                for c in d.execute(f'PRAGMA table_info("{name}")')
            ]
            objects.append({"name": name, "kind": kind, "columns": cols})
        _schema_cache["objects"] = objects
    return jsonify(objects=_schema_cache["objects"])


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


_info_cache = {}


@app.get("/api/info")
def info():
    """When the database was built and how fresh IMDb's data was (DB is immutable, so cache)."""
    if not _info_cache:
        meta = {}
        try:
            meta = dict(db().execute("SELECT key, value FROM meta").fetchall())
        except sqlite3.Error:
            pass  # older DB without a meta table
        updated = meta.get("imported_at")
        if not updated:  # fall back to the file's modification time
            updated = iso(Path(DB_PATH).stat().st_mtime)
        _info_cache.update(
            updated=updated,
            source_updated=meta.get("source_updated"),
            source="meta" if meta.get("imported_at") else "file",
        )
    return jsonify(_info_cache)


@app.get("/healthz")
@limiter.exempt
def healthz():
    return "ok"


@app.get("/sql")
def sql_page():
    return render_template("sql.html")


@app.get("/")
def index():
    return render_template("index.html")


if __name__ == "__main__":
    if "--build-search" in sys.argv:
        build_search()
    else:
        app.run(host="127.0.0.1", port=8000)
