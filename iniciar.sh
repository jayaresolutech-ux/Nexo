#!/usr/bin/env bash
cd "$(dirname "$0")"
ALVO=app.pyc
[ -f "$ALVO" ] || ALVO=app.py
exec python3 "$ALVO" "$@"
