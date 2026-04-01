#!/usr/bin/env bash
set -euo pipefail

echo "=== clawndom installer ==="
echo ""

# Check Node.js >= 22
if ! command -v node &> /dev/null; then
  echo "Error: Node.js is not installed." >&2
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "Error: Node.js >= 22 required (found $(node -v))" >&2
  exit 1
fi

# Check pnpm
if ! command -v pnpm &> /dev/null; then
  echo "Error: pnpm is not installed." >&2
  exit 1
fi

echo "Node.js $(node -v) and pnpm $(pnpm -v) detected."
echo ""

# --- Global configuration ---

read -rp "OPENCLAW_TOKEN: " OPENCLAW_TOKEN
if [ -z "$OPENCLAW_TOKEN" ]; then
  echo "Error: OPENCLAW_TOKEN is required." >&2
  exit 1
fi

read -rp "OpenClaw Hook URL [http://127.0.0.1:18789/hooks/agent]: " OPENCLAW_HOOK_URL
OPENCLAW_HOOK_URL="${OPENCLAW_HOOK_URL:-http://127.0.0.1:18789/hooks/agent}"

read -rp "REDIS_URL [redis://127.0.0.1:6379]: " REDIS_URL
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

read -rp "PORT [8792]: " PORT
PORT="${PORT:-8792}"

# --- Provider collection loop ---

echo ""
echo "Configure webhook providers (at least one required)."
echo ""

PROVIDERS_JSON="["
PROVIDER_COUNT=0

while true; do
  echo "--- Provider $((PROVIDER_COUNT + 1)) ---"

  read -rp "Provider name (e.g., jira, github) [leave blank to finish]: " PROVIDER_NAME
  if [ -z "$PROVIDER_NAME" ]; then
    break
  fi

  read -rp "Route path [/hooks/$PROVIDER_NAME]: " ROUTE_PATH
  ROUTE_PATH="${ROUTE_PATH:-/hooks/$PROVIDER_NAME}"

  read -rp "HMAC secret: " HMAC_SECRET
  if [ -z "$HMAC_SECRET" ]; then
    echo "Error: HMAC secret is required for each provider." >&2
    continue
  fi

  read -rp "Signature strategy (websub or github) [websub]: " SIG_STRATEGY
  SIG_STRATEGY="${SIG_STRATEGY:-websub}"

  if [ "$SIG_STRATEGY" != "websub" ] && [ "$SIG_STRATEGY" != "github" ]; then
    echo "Error: Signature strategy must be 'websub' or 'github'." >&2
    continue
  fi

  # Add comma separator between providers
  if [ "$PROVIDER_COUNT" -gt 0 ]; then
    PROVIDERS_JSON+=","
  fi

  PROVIDERS_JSON+="{\"name\":\"$PROVIDER_NAME\",\"routePath\":\"$ROUTE_PATH\",\"hmacSecret\":\"$HMAC_SECRET\",\"signatureStrategy\":\"$SIG_STRATEGY\",\"openclawHookUrl\":\"$OPENCLAW_HOOK_URL\",\"routing\":{\"default\":\"patch\"}}"
  PROVIDER_COUNT=$((PROVIDER_COUNT + 1))

  echo "Added provider: $PROVIDER_NAME ($ROUTE_PATH, $SIG_STRATEGY)"
  echo ""
done

PROVIDERS_JSON+="]"

if [ "$PROVIDER_COUNT" -eq 0 ]; then
  echo "Error: At least one provider is required." >&2
  exit 1
fi

echo ""
echo "$PROVIDER_COUNT provider(s) configured."
echo ""
echo "Building..."

# Install dependencies and build
pnpm install --frozen-lockfile
pnpm build

INSTALL_PATH="$(pwd)"
PLIST_SRC="infra/launchd/com.openclaw.clawndom.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.openclaw.clawndom.plist"

# Unload existing service if present
if launchctl list | grep -q com.openclaw.clawndom 2>/dev/null; then
  echo "Unloading existing service..."
  launchctl unload "$PLIST_DST" 2>/dev/null || true
fi

# Also unload old jira-proxy service if present
if launchctl list | grep -q com.openclaw.jira-proxy 2>/dev/null; then
  echo "Unloading old jira-proxy service..."
  launchctl unload "$HOME/Library/LaunchAgents/com.openclaw.jira-proxy.plist" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.openclaw.jira-proxy.plist"
fi

# Escape JSON for XML plist: " → &quot;, then escape & for sed replacement
PROVIDERS_CONFIG_ESCAPED="${PROVIDERS_JSON//\"/&quot;}"
PROVIDERS_CONFIG_SED_SAFE="${PROVIDERS_CONFIG_ESCAPED//&/\\&}"

# Configure plist
cp "$PLIST_SRC" "$PLIST_DST"
sed -i '' "s|__INSTALL_PATH__|$INSTALL_PATH|g" "$PLIST_DST"
sed -i '' "s|__OPENCLAW_TOKEN__|$OPENCLAW_TOKEN|g" "$PLIST_DST"
sed -i '' "s|__PROVIDERS_CONFIG__|$PROVIDERS_CONFIG_SED_SAFE|g" "$PLIST_DST"
sed -i '' "s|__REDIS_URL__|$REDIS_URL|g" "$PLIST_DST"
sed -i '' "s|__PORT__|$PORT|g" "$PLIST_DST"

# Load service
launchctl load "$PLIST_DST"

echo ""
echo "clawndom installed and running on port $PORT"
echo ""
echo "Next steps:"
echo "  1. Set up Tailscale Funnel for each provider:"
for i in $(seq 0 $((PROVIDER_COUNT - 1))); do
  ROUTE=$(echo "$PROVIDERS_JSON" | grep -o '"routePath":"[^"]*"' | sed -n "$((i + 1))p" | cut -d'"' -f4)
  echo "     tailscale funnel --bg --set-path $ROUTE $PORT"
done
echo "  2. Configure your webhook provider to point to https://<machine>.ts.net/hooks/<provider>"
echo "  3. Check health: curl http://localhost:$PORT/api/health"
