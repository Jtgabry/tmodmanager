#!/usr/bin/env bash
# Compila gli add-on (plugin TShock distribuiti con tModManager) in addons/dist/<Nome>.dll.
# L'agent li prende da lì (AGENT_ADDONS_DIR; nell'immagine Docker sono già compilati in /app/addons).
#   addons/build.sh               tutti
#   addons/build.sh LiveMap       solo quelli indicati
# Serve l'SDK .NET 9:  curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 9.0
set -euo pipefail
cd "$(dirname "$0")"

DOTNET=$(command -v dotnet || true)
[[ -z "$DOTNET" && -x "$HOME/.dotnet/dotnet" ]] && DOTNET="$HOME/.dotnet/dotnet"
[[ -n "$DOTNET" ]] || { echo "dotnet non trovato: serve l'SDK .NET 9" >&2; exit 1; }

if (($#)); then
  projects=("$@")
else
  projects=()
  for csproj in */*.csproj; do projects+=("$(dirname "$csproj")"); done
fi

mkdir -p dist
for project in "${projects[@]}"; do
  project=${project%/}
  [[ -f "$project/$project.csproj" ]] || { echo "Add-on non trovato: $project" >&2; exit 1; }
  "$DOTNET" build "$project" -c Release --nologo -v quiet -o "obj/out/$project"
  cp "obj/out/$project/$project.dll" dist/
  echo "addons/dist/$project.dll"
done
