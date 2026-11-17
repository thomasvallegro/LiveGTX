#!/bin/bash
# Avvio dei sottotitoli live. Doppio clic per aprire.
# La PRIMA volta serve internet (installa vosk + sounddevice e scarica il modello da ~48 MB).
# Dalla seconda volta in poi funziona completamente offline.

cd "$(dirname "$0")" || exit 1

MODELLO_NOME="vosk-model-small-it-0.22"
MODELLO_URL="https://alphacephei.com/vosk/models/${MODELLO_NOME}.zip"

fine() { echo; read -n1 -s -r -p "Premi un tasto per chiudere questa finestra..."; exit "$1"; }

if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERRORE] Python 3 non trovato."
  fine 1
fi

# 1) ambiente Python dedicato (non tocca il resto del Mac)
if [ ! -f ".venv/.installato" ]; then
  echo "Prima installazione: preparo l'ambiente Python (serve internet solo ora)..."
  rm -rf .venv
  python3 -m venv .venv || { echo "[ERRORE] impossibile creare l'ambiente Python."; fine 1; }
  .venv/bin/python -m pip install --quiet --upgrade pip
  .venv/bin/python -m pip install vosk sounddevice || { echo "[ERRORE] installazione non riuscita: controlla la connessione."; fine 1; }
  touch .venv/.installato
fi

# 2) modello italiano
if [ ! -d "modello" ]; then
  echo "Scarico il modello italiano (~48 MB)..."
  curl -L --fail -o modello.zip "$MODELLO_URL" || { echo "[ERRORE] download non riuscito: controlla la connessione."; rm -f modello.zip; fine 1; }
  unzip -q modello.zip && mv "$MODELLO_NOME" modello && rm modello.zip
  [ -d "modello" ] || { echo "[ERRORE] estrazione del modello non riuscita."; fine 1; }
fi

# 3) avvio
.venv/bin/python sottotitoli.py "$@"
fine 0
