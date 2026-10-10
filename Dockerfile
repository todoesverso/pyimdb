FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    IMDB_DB=/data/imdb.db

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY templates templates
COPY static static

# Run as an unprivileged user
RUN useradd --system --uid 10001 --no-create-home appuser
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"

# ONE worker + threads: per-IP query budgets are kept in process memory
CMD ["gunicorn", "--no-control-socket", "-w", "1", "--threads", "4", "--timeout", "30", \
     "--access-logfile", "-", "-b", "0.0.0.0:8000", "app:app"]
