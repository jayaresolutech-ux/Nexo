#!/usr/bin/env bash
# Cria o atalho "Mini ERP" na Área de Trabalho (Linux)
cd "$(dirname "$0")"
DIR="$(pwd)"
DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
mkdir -p "$DESK"
chmod +x iniciar.sh
ARQ="$DESK/Mini ERP.desktop"
cat > "$ARQ" <<EOF
[Desktop Entry]
Type=Application
Name=Mini ERP
Comment=Mini ERP - Gestão Empresarial
Exec="$DIR/iniciar.sh"
Path=$DIR
Icon=utilities-terminal
Terminal=true
Categories=Office;
EOF
chmod +x "$ARQ"
gio set "$ARQ" metadata::trusted true 2>/dev/null
echo "Atalho criado em: $ARQ"
