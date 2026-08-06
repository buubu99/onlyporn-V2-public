FROM ghcr.io/metatube-community/metatube-server@sha256:04d58879b76624e180cfdb24cde042b657189eabd3bd4cba851f1d56f7a5be82 AS metatube

FROM node:20-bookworm-slim
RUN apt-get update   && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-pip python3-venv procps   && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . /app
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund
COPY --from=metatube /metatube-server /usr/local/bin/metatube-server
RUN chmod 0755 /usr/local/bin/metatube-server /app/scripts/start-onlyporn-with-metatube.sh   && install -d -m 0700 /tmp/onlyporn-runtime /tmp/onlyporn-runtime/metatube /tmp/onlyporn-runtime/cache /tmp/onlyporn-runtime/logs /tmp/onlyporn-runtime/tmp
ENV NODE_ENV=production
ENV METATUBE_PORT=18080
ENV INTERNAL_ONLYPORN_PORT=10001
ENV ONLYPORN_RUNTIME_DIR=/tmp/onlyporn-runtime
ENV METATUBE_DB=/tmp/onlyporn-runtime/metatube/metatube.db
ENV DSN=/tmp/onlyporn-runtime/metatube/metatube.db
ENV DB_AUTO_MIGRATE=true
ENV DB_MAX_OPEN_CONNS=1
ENV DB_MAX_IDLE_CONNS=1
ENV DB_PREPARED_STMT=false
ENV ONLYPORN_PERSISTENT_CACHE_DIR=/tmp/onlyporn-runtime/cache
ENV ONLYPORN_CACHE_DIR=/tmp/onlyporn-runtime/cache
ENV ONLYPORN_PROCESS_LOG_DIR=/tmp/onlyporn-runtime/logs
ENV ONLYPORN_EPHEMERAL_MIN_FREE_MB=2048
ENV ONLYPORN_LOG_MAX_BYTES=10485760
ENV ONLYPORN_LOG_KEEP_BYTES=5242880
ENV TMPDIR=/tmp/onlyporn-runtime/tmp
ENV MT_MOVIE_PROVIDER_THEPORNDB__PRIORITY=0
ENV MT_MOVIE_PROVIDER_TPDB__PRIORITY=0
EXPOSE 10000
ENTRYPOINT ["/app/scripts/start-onlyporn-with-metatube.sh"]
