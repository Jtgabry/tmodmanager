#!/usr/bin/env bash
# Installer di tModManager.
#
#   Nella cartella clonata:   ./install.sh [opzioni]
#   Senza clonare:            curl -fsSL <url di install.sh> | bash -s -- [opzioni]
#
# Senza cartella clonata, il progetto viene scaricato in TMM_DIR (default ~/tmodmanager) da TMM_REPO.
# Il resto lo fa "./tmm install" (opzioni: ./tmm install --help).
set -euo pipefail

REPO="${TMM_REPO:-https://github.com/Jtgabry/tmodmanager.git}"
DIR="${TMM_DIR:-$HOME/tmodmanager}"

here=''
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$here" ] && [ -x "$here/tmm" ] && [ -f "$here/docker-compose.yml" ]; then
  exec "$here/tmm" install "$@"
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Serve git: lo installo (sudo apt-get install git)…"
  sudo apt-get update -qq && sudo apt-get install -y git
fi

if [ -d "$DIR/.git" ]; then
  echo "Aggiorno $DIR…"
  git -C "$DIR" pull --ff-only
else
  echo "Scarico tModManager in $DIR…"
  # Repository privato: git chiede le credenziali sul terminale
  # (/dev/tty può esistere senza essere apribile: cron, CI, ssh senza -t)
  if { : </dev/tty; } 2>/dev/null; then git clone "$REPO" "$DIR" </dev/tty; else git clone "$REPO" "$DIR"; fi
fi

exec "$DIR/tmm" install "$@"
