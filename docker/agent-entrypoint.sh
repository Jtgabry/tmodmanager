#!/bin/sh
# Parte come root solo per preparare l'utente (stesso UID/GID del proprietario di data/ sull'host,
# così i file restano suoi), poi passa a quell'utente. screen richiede un utente esistente in
# /etc/passwd e una cartella per i socket di proprietà dell'utente con permessi 700.
set -eu

uid="${TMM_UID:-1000}"

# Fuso orario (backup giornalieri all'ora locale): TMM_TZ dal .env, altrimenti /etc/localtime dell'host
if [ -n "${TMM_TZ:-}" ] && [ -f "/usr/share/zoneinfo/$TMM_TZ" ]; then export TZ="$TMM_TZ"; fi
gid="${TMM_GID:-1000}"

if [ "$(id -u)" = "0" ]; then
  getent group "$gid" >/dev/null || groupadd -g "$gid" tmm
  getent passwd "$uid" >/dev/null || useradd -u "$uid" -g "$gid" -m -d /home/tmm -s /bin/sh tmm
  user="$(getent passwd "$uid" | cut -d: -f1)"
  home="$(getent passwd "$uid" | cut -d: -f6)"

  mkdir -p "$home/.screen" "$TMM_DATA_DIR"
  chown "$uid:$gid" "$home" "$home/.screen" "$TMM_DATA_DIR"
  chmod 700 "$home/.screen"

  export HOME="$home" USER="$user" LOGNAME="$user" SCREENDIR="$home/.screen"
  exec setpriv --reuid="$uid" --regid="$gid" --init-groups "$@"
fi

export SCREENDIR="${SCREENDIR:-$HOME/.screen}"
mkdir -p "$SCREENDIR" && chmod 700 "$SCREENDIR"
exec "$@"
