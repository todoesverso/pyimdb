# IMDb Web

A read-only IMDb title search and SQLite query console. The app serves a local IMDb database, provides full-text title search, and lets users explore data with bounded, read-only SQL queries and charts.

## Requirements

- Docker Engine and the Docker Compose v2 plugin for the container workflow
- Several tens of gigabytes of free disk space for a full IMDb import and its temporary update copy
- Or Python 3.12+ for local development

The IMDb datasets are large. The full import includes `title.akas`, `title.crew`, and `title.episode`; the slim import omits these optional datasets and uses less disk.

## Quick Start

From the project directory, build the database, create the search index, and start the app:

```sh
make import
make index
make up
```

Open <http://localhost:8000>. `make import` downloads IMDb's public TSV datasets, builds `data/imdb.db`, and creates the app's additional indexes. `make index` adds the FTS5 search index, compatibility views, and database metadata. The app mounts the database read-only.

To import only the datasets needed for core search and title/person browsing:

```sh
make import-slim
make index
make up
```

The slim import skips aliases and some auxiliary tables. For country/market alias queries, use the full import.

## Local Development

Create the virtual environment and install dependencies:

```sh
make venv
make import-slim
make dev-index
make dev
```

The local server binds to `127.0.0.1:8000`. Override the port or database path with Make variables, for example `make dev PORT=9000 DB=data/imdb.db`.

## Updating Data

`make update` downloads fresh datasets into a staging database, indexes it, swaps it into place, and restarts the app. The existing database remains in service while the replacement is built. `make update-slim` performs the same flow with the slim dataset set.

On a Linux host with `flock`, `make cron-install` installs a daily update job (default 05:30). Set `UPDATE_TARGET=update-slim` to use the slim update. Use `make cron-remove` to remove the job.

## Public Access with Cloudflare Tunnel

1. Copy `.env.example` to `.env` and set `TUNNEL_TOKEN` to the token for your Cloudflare Tunnel.
2. In Cloudflare Zero Trust, configure a public hostname route to `http://app:8000`.
3. Start the app and tunnel:

```sh
make tunnel
```

The app's host port is bound to localhost; Cloudflare Tunnel connects outbound, so no router port forwarding is needed. Keep `.env` secret and do not commit it.

## Features and Safety

- Full-text title search, title details, cast/crew links, and person filmographies
- SQL console with schema browser, examples, local recent-query history, charts, and chart export
- SQL is run against a read-only SQLite connection. The console limits query duration, result rows, cell length, request rates, per-IP query time, and concurrent queries.
- The query budgets are in process memory, so the app is configured for one Gunicorn worker with multiple threads.
- JSON access logs go to container stdout and include client IP, Cloudflare Ray ID, request ID, method, path, status, duration, response size, and user agent. Query strings and request bodies are intentionally omitted; `/healthz` probes are not logged. Docker retains at most five 10 MB log files, so export logs elsewhere if longer retention is needed.
- Chart.js and CodeMirror are loaded from pinned CDNJS URLs. The SQL editor falls back to a textarea, and charts fall back to native SVG if their CDN library is unavailable.

The database is not included in Git. `data/`, download caches, and generated database files are ignored. Build or copy the database onto the host before starting the app.

## IMDb Data Terms

This repository's application code is licensed under the MIT License (see [LICENSE](LICENSE)). The IMDb datasets are a separate work, provided under IMDb's [non-commercial datasets terms](https://developer.imdb.com/non-commercial-datasets/). Those terms restrict the data to personal and non-commercial use; the MIT license for this code does not change or grant rights to the IMDb data.
