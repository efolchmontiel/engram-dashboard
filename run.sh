#!/bin/sh
# Dashboard local de Engram — arranca en 127.0.0.1:7438 o, si está ocupado, en el
# siguiente puerto libre (lo informa en pantalla).
# Uso: ./run.sh [puerto]
# Variables opcionales: ENGRAM_DASH_PORT, ENGRAM_PORT, ENGRAM_API,
# ENGRAM_DATA_DIR, ENGRAM_BIN, ENGRAM_HTTP_TOKEN (passthrough).
if [ -n "$1" ]; then
    ENGRAM_DASH_PORT="$1"
    export ENGRAM_DASH_PORT
fi
exec python3 "$(dirname "$0")/server.py"
