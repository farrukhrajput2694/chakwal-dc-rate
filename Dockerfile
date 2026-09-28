# Chakwal DC Rate Calculator -- container image.
#
# The app is pure Python with no build step, so this is a thin image: install
# dependencies, copy the source, run uvicorn. The portal-facing behaviour that
# matters is pinned here rather than left to defaults:
#
#   --workers 1        BATCH_CONCURRENCY is a per-process semaphore, so extra
#                      workers would multiply the requests in flight against the
#                      government portal. One worker keeps the promise of four.
#   --proxy-headers    so the app sees the real client scheme/host behind nginx.
#   --timeout-keep-alive
#                      long enough to survive an idle browser between requests.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000

WORKDIR /app

# Dependencies first, so an edit to the source does not re-resolve them.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py govapi.py ./
COPY static ./static

# history.db is created on first run and stays empty -- nothing is saved.
RUN useradd --system --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# /health deliberately does not call the portal, so probing it every few
# seconds costs the government server nothing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os,urllib.request;urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/health',timeout=4)"

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT} --workers 1 --proxy-headers --forwarded-allow-ips='*' --timeout-keep-alive 75"]
