#!/bin/sh
# Prepara storage e database nella cartella dati, applica le migrazioni e mette in cache la
# configurazione; poi avvia FrankenPHP. Gira già come utente TMM_UID (vedi docker-compose.yml).
set -eu
cd "${APP_DIR:-/app/backend}"

if [ -z "${APP_KEY:-}" ]; then
  echo "APP_KEY mancante: va impostata nel file .env (l'installer la genera da solo)." >&2
  exit 1
fi

for dir in app/private framework/cache/data framework/sessions framework/views logs; do
  mkdir -p "$LARAVEL_STORAGE_PATH/$dir"
done
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"

if [ "${DB_CONNECTION:-sqlite}" = "sqlite" ]; then
  db="${DB_SQLITE_DATABASE:-$TMM_DATA_DIR/database.sqlite}"
  [ -f "$db" ] || touch "$db"
fi

php artisan migrate --force --no-interaction
php artisan config:cache --no-interaction
php artisan route:cache --no-interaction
php artisan event:cache --no-interaction

exec "$@"
