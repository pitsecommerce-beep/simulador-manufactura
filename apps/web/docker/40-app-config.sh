#!/bin/sh
# Genera /config.js con las variables del servicio web en Railway.
set -eu

for v in API_URL SUPABASE_URL SUPABASE_PUBLISHABLE_KEY; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then
    echo "ERROR: falta la variable $v" >&2
    exit 1
  fi
  case "$val" in
    *\"*|*\\*|*"<"*) echo "ERROR: $v contiene caracteres no permitidos" >&2; exit 1 ;;
  esac
done

cat > /usr/share/nginx/html/config.js <<JS
window.__APP_CONFIG__ = {
  apiUrl: "${API_URL}",
  supabaseUrl: "${SUPABASE_URL}",
  supabasePublishableKey: "${SUPABASE_PUBLISHABLE_KEY}"
};
JS
echo "config.js generado para API ${API_URL}"
