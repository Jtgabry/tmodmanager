#!/usr/bin/env bash
# Compila gli add-on di tModManager in addons/dist/:
#   - plugin TShock (es. LiveMap)            → dist/<Nome>.dll
#   - mod tModLoader (es. TmmLiveMap, con build.txt) → dist/<Nome>.tmod
# e ricava i colori della mappa di Terraria in dist/map-colors.json (tools/MapColors).
# L'agent li prende da lì (AGENT_ADDONS_DIR; nell'immagine Docker sono già compilati in /app/addons).
#   addons/build.sh               tutti
#   addons/build.sh LiveMap       solo quelli indicati
# Serve l'SDK .NET 9:  curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 9.0
# Per le mod serve tModLoader (solo per compilare, non viene avviato): TML_PATH=<cartella di un'installazione>,
# altrimenti si scarica in addons/.tml la versione di tmodloader.version (la più vecchia supportata: tModLoader
# rifiuta le mod compilate per una versione più nuova della sua).
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

# tModLoader per compilare le mod: solo tModLoader.dll e Libraries/ dello zip della release
tml_path() {
  if [[ -n "${TML_PATH:-}" ]]; then
    [[ -f "$TML_PATH/tModLoader.dll" ]] || { echo "tModLoader non trovato in TML_PATH=$TML_PATH" >&2; exit 1; }
    realpath "$TML_PATH"
    return
  fi
  local version dir
  version=$(tr -d '[:space:]' < tmodloader.version)
  dir=".tml/$version"
  if [[ ! -f "$dir/tModLoader.dll" ]]; then
    echo "Scarico tModLoader $version (solo per compilare)…" >&2
    rm -rf "$dir" && mkdir -p "$dir"
    curl -fsSL -o "$dir.zip" "https://github.com/tModLoader/tModLoader/releases/download/$version/tModLoader.zip"
    unzip -q "$dir.zip" 'tModLoader.dll' 'Libraries/*' -d "$dir"
    rm -f "$dir.zip"
  fi
  realpath "$dir"
}

mkdir -p dist
tml=
for project in "${projects[@]}"; do
  project=${project%/}
  [[ -f "$project/$project.csproj" ]] || { echo "Add-on non trovato: $project" >&2; exit 1; }
  if [[ -f "$project/build.txt" ]]; then
    [[ -n "$tml" ]] || { tml=$(tml_path); "$DOTNET" build tools/TmodPack -c Release --nologo -v quiet -o obj/TmodPack >/dev/null; }
    "$DOTNET" build "$project" -c Release --nologo -v quiet -p:TmlPath="$tml/" -o "obj/out/$project"
    "$DOTNET" obj/TmodPack/TmodPack.dll "$project" "obj/out/$project/$project.dll" "$tml/tModLoader.dll" "dist/$project.tmod" >/dev/null
    echo "addons/dist/$project.tmod"
  else
    "$DOTNET" build "$project" -c Release --nologo -v quiet -o "obj/out/$project"
    cp "obj/out/$project/$project.dll" dist/
    echo "addons/dist/$project.dll"
  fi
done

# Colori della minimappa di Terraria, per disegnare la mappa dai file del mondo (.wld) nell'agent
if ((!$#)); then
  "$DOTNET" run --project tools/MapColors -c Release -v quiet -- dist/map-colors.json
fi
