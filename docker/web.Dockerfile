# syntax=docker/dockerfile:1
# Sito di tModManager: FrankenPHP (Caddy + PHP) serve la SPA, l'API Laravel e inoltra /ws/ all'agent.
# HTTPS automatico (Let's Encrypt) quando TMM_SITE_ADDRESS è un dominio.

FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM composer:2 AS vendor
WORKDIR /app/backend
COPY backend/composer.json backend/composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --prefer-dist --no-interaction --ignore-platform-reqs
COPY backend/ ./
RUN composer dump-autoload --optimize --classmap-authoritative --no-dev --no-scripts

FROM dunglas/frankenphp:1-php8.4-bookworm
RUN install-php-extensions pdo_sqlite pdo_mysql intl opcache zip bcmath \
 && apt-get update \
 && apt-get install -y --no-install-recommends libcap2-bin \
 && setcap cap_net_bind_service=+ep /usr/local/bin/frankenphp \
 && apt-get purge -y libcap2-bin && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY docker/php.ini "$PHP_INI_DIR/conf.d/zz-tmodmanager.ini"
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=755 docker/web-entrypoint.sh /usr/local/bin/tmm-web-entrypoint

WORKDIR /app/backend
COPY --from=vendor /app/backend ./
COPY --from=frontend /app/frontend/dist /app/frontend/dist
# storage/ sta nella cartella dati (LARAVEL_STORAGE_PATH); bootstrap/cache viene riempita all'avvio
RUN rm -rf storage bootstrap/cache/*.php .env \
 && chmod 1777 bootstrap/cache \
 && php artisan package:discover --ansi

ENV APP_ENV=production \
    TMM_DATA_DIR=/srv/tmm-data \
    LARAVEL_STORAGE_PATH=/srv/tmm-data/web/storage \
    XDG_DATA_HOME=/srv/tmm-data/web/caddy \
    XDG_CONFIG_HOME=/tmp/caddy-config \
    DB_CONNECTION=sqlite \
    LOG_CHANNEL=stderr \
    AGENT_URL=http://agent:7878

# Il controllo dell'immagine base usa l'endpoint admin di Caddy (qui disattivato): basta che Caddy risponda
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s \
  CMD curl -sS -o /dev/null --max-time 4 http://127.0.0.1:80/up || exit 1

ENTRYPOINT ["tmm-web-entrypoint"]
CMD ["frankenphp", "run", "--config", "/etc/caddy/Caddyfile"]
