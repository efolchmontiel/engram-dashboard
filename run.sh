#!/bin/sh
# Dashboard local de Engram — arranca por defecto en 127.0.0.1:7438
# Variables opcionales: ENGRAM_DASH_PORT, ENGRAM_PORT, ENGRAM_API,
# ENGRAM_DATA_DIR, ENGRAM_BIN, ENGRAM_HTTP_TOKEN (passthrough).
exec python3 "$(dirname "$0")/server.py"
