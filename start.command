#!/bin/bash
# Doppio clic per avviare LiveGFX su macOS
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  # Percorsi tipici di Node su Mac (Homebrew / installer ufficiale)
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "✖ Node.js non è installato."
  echo "  Scaricalo da https://nodejs.org (versione LTS), installalo e riapri questo file."
  echo ""
  read -n 1 -s -r -p "Premi un tasto per chiudere…"
  exit 1
fi

if [ ! -d node_modules/ws ]; then
  echo "Prima installazione delle dipendenze…"
  npm install --omit=dev || { read -n 1 -s -r -p "Errore. Premi un tasto…"; exit 1; }
fi

# Apre il pannello nel browser dopo un secondo
( sleep 1.5 && open "http://localhost:3000/" ) &
node server.js
