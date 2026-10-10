#!/usr/bin/env python3
"""
Download the official IMDb non-commercial datasets and load them into SQLite.

Usage:
    python pyimdb.py                      # all tables -> imdb.db
    python pyimdb.py --db my.db
    python pyimdb.py --only title.basics title.ratings
    python pyimdb.py --skip title.principals title.akas   # skip the huge ones
    python pyimdb.py --force-download     # ignore cached files
    python pyimdb.py --no-extra-indexes   # omit covering and NOCASE indexes

Safe to run daily: cached files are only re-downloaded when IMDb has published
a newer version (conditional request). A `meta` table records when the database
was built (imported_at) and how fresh IMDb's data is (source_updated).

Data source / license: https://developer.imdb.com/non-commercial-datasets/
(Personal and non-commercial use only.)
"""

import argparse
import csv
import gzip
import http.client
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.utils import formatdate, parsedate_to_datetime

BASE_URL = (
    os.environ.get("IMDB_BASE_URL", "https://datasets.imdbws.com").rstrip("/")
    + "/{}.tsv.gz"
)

DATASETS = [
    "name.basics",
    "title.basics",
    "title.akas",
    "title.crew",
    "title.episode",
    "title.principals",
    "title.ratings",
]

# Columns that should be numeric; everything else is TEXT.
INT_COLS = {
    "isAdult",
    "startYear",
    "endYear",
    "runtimeMinutes",
    "birthYear",
    "deathYear",
    "seasonNumber",
    "episodeNumber",
    "ordering",
    "isOriginalTitle",
    "numVotes",
}
REAL_COLS = {"averageRating"}

INDEXES = {
    "name.basics": ["nconst", "primaryName"],
    "title.basics": ["tconst", "titleType", "startYear", "primaryTitle"],
    "title.akas": ["titleId"],
    "title.crew": ["tconst"],
    "title.episode": ["tconst", "parentTconst"],
    "title.principals": ["tconst", "nconst"],
    "title.ratings": ["tconst"],
}

EXTRA_INDEXES = {
    "name.basics": [("primaryName_nocase", '"primaryName" COLLATE NOCASE')],
    "title.basics": [("primaryTitle_nocase", '"primaryTitle" COLLATE NOCASE')],
    "title.ratings": [
        (
            "numVotes_tconst_averageRating",
            '"numVotes", "tconst", "averageRating"',
        )
    ],
}

BATCH = 100_000
DOWNLOAD_TIMEOUT = 60
DOWNLOAD_ATTEMPTS = 3


def table_name(dataset: str) -> str:
    return dataset.replace(".", "_")


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def download(dataset: str, dest_dir: str, force: bool = False) -> str:
    """Download a dataset unless the cached copy is still current.

    The cached file's mtime is set to the server's Last-Modified time, so the next
    run can ask "has this changed since then?" (If-Modified-Since) and get a cheap
    304 instead of re-downloading ~1 GB.
    """
    os.makedirs(dest_dir, exist_ok=True)
    path = os.path.join(dest_dir, f"{dataset}.tsv.gz")
    url = BASE_URL.format(dataset)

    headers = {"User-Agent": "Mozilla/5.0"}
    if os.path.exists(path) and not force:
        headers["If-Modified-Since"] = formatdate(os.path.getmtime(path), usegmt=True)

    tmp = path + ".part"
    try:
        for attempt in range(DOWNLOAD_ATTEMPTS):
            try:
                with urllib.request.urlopen(
                    urllib.request.Request(url, headers=headers),
                    timeout=DOWNLOAD_TIMEOUT,
                ) as resp:
                    print(f"[{dataset}] downloading {url}")
                    total = int(resp.headers.get("Content-Length", 0))
                    read = 0
                    with open(tmp, "wb") as out:
                        while chunk := resp.read(1 << 20):
                            out.write(chunk)
                            read += len(chunk)
                            if total:
                                print(
                                    f"\r  {read / 1e6:,.0f} / {total / 1e6:,.0f} MB ({read * 100 // total}%)",
                                    end="",
                                    flush=True,
                                )
                    print()
                    last_modified = resp.headers.get("Last-Modified")
            except urllib.error.HTTPError as e:
                if e.code == 304:
                    print(
                        f"[{dataset}] cached copy is current ({iso(os.path.getmtime(path))}), skipping download"
                    )
                    return path
                if e.code != 408 and e.code != 429 and e.code < 500:
                    raise
                error = e
            except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException) as e:
                error = e
            else:
                if last_modified:
                    try:
                        ts = parsedate_to_datetime(last_modified).timestamp()
                        os.utime(tmp, (ts, ts))
                    except (TypeError, ValueError):
                        pass  # keep download time as mtime
                os.replace(tmp, path)
                return path

            try:
                os.remove(tmp)
            except FileNotFoundError:
                pass
            if attempt + 1 == DOWNLOAD_ATTEMPTS:
                raise error
            delay = min(2**attempt, 8)
            print(f"[{dataset}] download failed ({error}); retrying in {delay}s")
            time.sleep(delay)
    finally:
        try:
            os.remove(tmp)
        except FileNotFoundError:
            pass
    raise RuntimeError("Download attempts exhausted")


def convert(value: str, col: str):
    if value == r"\N":
        return None
    if col in INT_COLS:
        try:
            return int(value)
        except ValueError:
            return None
    if col in REAL_COLS:
        try:
            return float(value)
        except ValueError:
            return None
    return value


def load(
    conn: sqlite3.Connection,
    dataset: str,
    gz_path: str,
    include_extra_indexes: bool = True,
):
    table = table_name(dataset)
    print(f"[{dataset}] loading into table '{table}'")

    # QUOTE_NONE: IMDb TSVs contain stray double quotes that are not escapes.
    with gzip.open(gz_path, "rt", encoding="utf-8", newline="") as f:
        reader = csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE)
        header = next(reader)

        col_defs = []
        for c in header:
            if c in INT_COLS:
                t = "INTEGER"
            elif c in REAL_COLS:
                t = "REAL"
            else:
                t = "TEXT"
            col_defs.append(f'"{c}" {t}')

        conn.execute(f'DROP TABLE IF EXISTS "{table}"')
        conn.execute(f'CREATE TABLE "{table}" ({", ".join(col_defs)})')

        placeholders = ",".join("?" * len(header))
        insert = f'INSERT INTO "{table}" VALUES ({placeholders})'

        batch, total = [], 0
        for row in reader:
            if len(row) != len(header):
                continue  # skip malformed lines
            batch.append([convert(v, c) for v, c in zip(row, header)])
            if len(batch) >= BATCH:
                conn.executemany(insert, batch)
                total += len(batch)
                batch.clear()
                print(f"\r  {total:,} rows", end="", flush=True)
        if batch:
            conn.executemany(insert, batch)
            total += len(batch)
        conn.commit()
        print(f"\r  {total:,} rows loaded")

    # Create indexes after the bulk insert (much faster)
    for col in INDEXES.get(dataset, []):
        print(f"  indexing {table}.{col}")
        conn.execute(
            f'CREATE INDEX IF NOT EXISTS "idx_{table}_{col}" ON "{table}"("{col}")'
        )
    if include_extra_indexes:
        for name, columns in EXTRA_INDEXES.get(dataset, []):
            print(f"  indexing {table}.{name}")
            conn.execute(
                f'CREATE INDEX IF NOT EXISTS "idx_{table}_{name}" ON "{table}"({columns})'
            )
    conn.commit()


def write_meta(conn: sqlite3.Connection, datasets, source_times):
    """Record when this database was built and how fresh IMDb's data is."""
    conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    rows = {
        "imported_at": iso(datetime.now(timezone.utc).timestamp()),
        "source_updated": iso(max(source_times)),
        "datasets": ",".join(datasets),
    }
    conn.executemany("INSERT OR REPLACE INTO meta VALUES (?, ?)", rows.items())
    conn.commit()
    print(f"Meta: {rows}")


def main():
    ap = argparse.ArgumentParser(description="Download IMDb datasets into SQLite")
    ap.add_argument(
        "--db", default="imdb.db", help="output SQLite file (default: imdb.db)"
    )
    ap.add_argument(
        "--dir", default="imdb_downloads", help="where to keep the .tsv.gz files"
    )
    ap.add_argument("--only", nargs="+", choices=DATASETS, help="only these datasets")
    ap.add_argument(
        "--skip", nargs="+", choices=DATASETS, default=[], help="skip these datasets"
    )
    ap.add_argument(
        "--force-download",
        action="store_true",
        help="ignore cached files and download again",
    )
    ap.add_argument(
        "--delete-downloads", action="store_true", help="remove .tsv.gz after loading"
    )
    ap.add_argument(
        "--no-extra-indexes",
        action="store_true",
        help="skip covering and case-insensitive indexes to reduce database size",
    )
    args = ap.parse_args()

    selected = [d for d in (args.only or DATASETS) if d not in args.skip]
    if not selected:
        sys.exit("Nothing to do.")

    conn = sqlite3.connect(args.db)
    # Speed up bulk loading
    conn.execute("PRAGMA journal_mode = OFF")
    conn.execute("PRAGMA synchronous = OFF")
    conn.execute("PRAGMA cache_size = -1000000")  # ~1 GB
    conn.execute("PRAGMA temp_store = MEMORY")

    source_times = []
    for ds in selected:
        path = download(ds, args.dir, args.force_download)
        source_times.append(
            os.path.getmtime(path)
        )  # = IMDb's Last-Modified when provided
        load(conn, ds, path, include_extra_indexes=not args.no_extra_indexes)
        if args.delete_downloads:
            os.remove(path)

    write_meta(conn, selected, source_times)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("ANALYZE")
    conn.close()
    print(f"\nDone -> {args.db}")


if __name__ == "__main__":
    main()
