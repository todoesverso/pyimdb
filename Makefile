# imdb-web Makefile  --  run `make` or `make help` to list targets.
#
# Typical first run:   make import && make index && make up
# Daily auto-update:   make cron-install   (runs `make update` from cron)
# Needs pyimdb.py (the IMDb -> SQLite loader) in this folder.

COMPOSE     ?= docker compose
DATA_DIR    ?= data
DB          ?= $(DATA_DIR)/imdb.db
CACHE_DIR   ?= .imdb-cache
PORT        ?= 8000
IMPORT_ARGS ?=
INDEX_DB    ?= $(DB)
UPDATE_TARGET ?= update
CRON_TIME   ?= 30 5 * * *
SLIM_ARGS   := --only name.basics title.basics title.principals title.ratings
PYIMDB      ?= pyimdb.py
VENV_STAMP  := venv/.installed
PY          := venv/bin/python

.DEFAULT_GOAL := help
.PHONY: help fetch import import-slim update update-slim cron-install cron-remove index build-search \
	    build up down restart logs ps stats shell health test unit-test venv dev dev-index clean \
	    check-data check-pyimdb

help: ## Show this help
	@echo "imdb-web targets (override vars like: make up PORT=9000):"
	@echo
	@grep -hE '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

# ---------------------------------------------------------------- data

fetch: $(VENV_STAMP) check-pyimdb ## Download + load IMDb data into data/imdb.db.new (the live DB is untouched)
	@mkdir -p $(DATA_DIR) $(CACHE_DIR)
	@rm -f $(DB).new
	SSL_CERT_FILE=$$($(PY) -c "import certifi; print(certifi.where())") \
		$(PY) $(PYIMDB) --db $(DB).new --dir $(CACHE_DIR) $(IMPORT_ARGS)

import: fetch ## First-time import: build data/imdb.db with pyimdb.py (then run: make index)
	mv -f $(DB).new $(DB)
	@echo "Built $(DB). Next: make index"

import-slim: ## Same as import, but only the 4 datasets the app needs (skips akas/crew/episode)
	$(MAKE) import IMPORT_ARGS="$(SLIM_ARGS) $(IMPORT_ARGS)"

index: ## Build the title search index (+ views, meta) inside INDEX_DB (default: data/imdb.db)
	@test -f $(INDEX_DB) || { echo "Missing $(INDEX_DB). Run 'make import' first."; exit 1; }
	$(COMPOSE) --profile tools build build-search
	$(COMPOSE) --profile tools run --rm -e IMDB_DB=/data/$(notdir $(INDEX_DB)) build-search

build-search: index ## Alias for index

update: ## Daily job: fetch fresh data into a NEW db, index it, swap it in, restart the app
	@echo "== update started $$(date -u +%FT%TZ)"
	$(MAKE) fetch
	$(MAKE) index INDEX_DB=$(DB).new
	mv -f $(DB).new $(DB)
	$(COMPOSE) restart app || $(COMPOSE) up -d app
	$(COMPOSE) up -d --force-recreate nginx
	@echo "== update finished $$(date -u +%FT%TZ)"

update-slim: ## Same as update, but only the 4 datasets the app needs (needs ~half the disk)
	$(MAKE) update IMPORT_ARGS="$(SLIM_ARGS) $(IMPORT_ARGS)"

cron-install: ## Install a daily cron job (CRON_TIME, default 05:30; UPDATE_TARGET=update-slim for slim)
	@command -v flock >/dev/null || { echo "flock not found (Linux/Raspberry Pi OS has it)"; exit 1; }
	@t=$$(mktemp) && { crontab -l 2>/dev/null | grep -v 'imdb-web-update' > $$t || true; } && \
	  echo "$(CRON_TIME) cd $(CURDIR) && flock -n /tmp/imdb-web-update.lock make $(UPDATE_TARGET) >> update.log 2>&1 # imdb-web-update" >> $$t && \
	  crontab $$t && rm -f $$t
	@echo "Installed:"; crontab -l | grep 'imdb-web-update'

cron-remove: ## Remove the daily cron job
	@t=$$(mktemp) && { crontab -l 2>/dev/null | grep -v 'imdb-web-update' > $$t || true; } && crontab $$t && rm -f $$t
	@echo "Removed."

# ----------------------------------------------------------------- app

build: ## Build the Docker image
	$(COMPOSE) build app

up: check-data ## Build (if needed) and start the app behind Nginx
	$(COMPOSE) up -d --build app nginx
	@echo "App running at http://localhost:$(PORT)"

down: ## Stop and remove all containers (app, Nginx, tools); data is kept
	$(COMPOSE) --profile tools down --remove-orphans

restart: ## Restart the app and clear the Nginx cache
	$(COMPOSE) restart app
	$(COMPOSE) up -d --force-recreate nginx

logs: ## Follow the app logs
	$(COMPOSE) logs --tail=100 -f app

ps: ## Show container status
	$(COMPOSE) ps

stats: ## Live CPU / memory usage of the containers
	docker stats --no-stream $$($(COMPOSE) ps -q)

shell: ## Open a shell inside the running app container
	$(COMPOSE) exec app sh

health: ## Check the health endpoint
	@curl -fsS http://127.0.0.1:$(PORT)/healthz && echo

test: ## Smoke-test search, the SQL console, and write-protection
	@echo "-- search:"
	@curl -fsS "http://127.0.0.1:$(PORT)/api/search?q=casablanca" | head -c 300; echo
	@echo "-- select (should return rows):"
	@curl -fsS -X POST -H 'Content-Type: application/json' \
	    -d '{"sql":"select count(*) as titles from titles"}' http://127.0.0.1:$(PORT)/api/query; echo
	@echo "-- delete (should be rejected):"
	@code=$$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
	    -d '{"sql":"delete from titles"}' http://127.0.0.1:$(PORT)/api/query) || { echo "Delete request failed"; exit 1; }; \
	  test "$$code" = 400 || { echo "Expected HTTP 400 for DELETE, got $$code"; exit 1; }; \
	  echo "Write blocked (HTTP $$code)"

unit-test: ## Run isolated application unit tests (no live server or IMDb database needed)
	$(PY) -m unittest discover -s tests -v

# ------------------------------------------------- local dev (no Docker)

venv: $(VENV_STAMP) ## Create the local virtualenv (app deps + certifi for pyimdb.py)

$(VENV_STAMP): requirements.txt
	python3 -m venv venv
	venv/bin/pip install -q -r requirements.txt certifi
	@touch $@

dev: $(VENV_STAMP) check-data ## Run the app locally with gunicorn, without Docker
	IMDB_DB=$(DB) venv/bin/gunicorn -w 1 --threads 4 --no-control-socket -b 127.0.0.1:$(PORT) app:app

dev-index: $(VENV_STAMP) check-data ## Build the search index locally, without Docker
	IMDB_DB=$(DB) $(PY) app.py --build-search

# ------------------------------------------------------------- cleanup

clean: ## Remove containers, built images and the local venv (keeps data/)
	$(COMPOSE) --profile tools down --remove-orphans --rmi local
	rm -rf venv __pycache__

# ------------------------------------------------------------- helpers

check-data:
	@test -f $(DB) || { echo "Missing $(DB). Run 'make import' or copy your imdb.db there."; exit 1; }

check-pyimdb:
	@test -f $(PYIMDB) || { echo "Missing $(PYIMDB) in this folder (or run: make import PYIMDB=/path/to/pyimdb.py)"; exit 1; }
