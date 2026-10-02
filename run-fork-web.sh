#!/usr/bin/env bash
# run-fork-web.sh — persistent anvil forks for the web-UI onchain E2E suite.
# One fork per network, unique port 18545–18556 (never collides with the
# transient fork harness ports 8545–8548 used by run-fork-all.sh).
# Usage: run-fork-web.sh [start|stop|status]
set -u
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG="$ROOT/logs/web-fork"
PIDFILE="$LOG/pids"
mkdir -p "$LOG"

stop_all() {
  [ -f "$PIDFILE" ] || { echo "no pids file"; return 0; }
  while read -r pid; do kill "$pid" 2>/dev/null || true; done < "$PIDFILE"
  rm -f "$PIDFILE"
  echo "web-fork anvils stopped"
}

# networkId => port|chainId|upstream RPC (mirrors js/network.js order)
declare -A NET=(
  [ethereum]="18545|1|https://ethereum-rpc.publicnode.com"
  [bsc]="18546|56|https://bsc-rpc.publicnode.com"
  [polygon]="18547|137|https://polygon.drpc.org"
  [arbitrum]="18548|42161|https://arb1.arbitrum.io/rpc"
  [optimism]="18549|10|https://mainnet.optimism.io"
  [base]="18550|8453|https://mainnet.base.org"
  [sepolia]="18551|11155111|https://sepolia.gateway.tenderly.co"
  [amoy]="18552|80002|https://polygon-amoy-bor-rpc.publicnode.com"
  [arbitrum-sepolia]="18553|421614|https://arbitrum-sepolia-rpc.publicnode.com"
  [op-sepolia]="18554|11155420|https://sepolia.optimism.io"
  [base-sepolia]="18555|84532|https://sepolia.base.org"
  [bsc-testnet]="18556|97|https://bsc-testnet-rpc.publicnode.com"
)

# Fallback upstream RPCs for EVERY network, drawn from the second/third entry
# in js/network.js so the candidates are endpoints the app itself already
# trusts. restart-one rotates primary → alt → primary → alt across 4 attempts:
# CI 36955492385 failed 8 sends because the health gate (a real estimateGas)
# could not get state from ONE upstream — either a fast JSON-RPC error or a
# 20s hang — and with no alt to rotate to, all three attempts asked the same
# rate-limited host the same question. A different provider is a different
# rate bucket, which is the only thing that helps against 429s.
declare -A ALT=(
  [ethereum]="https://eth.drpc.org"
  [bsc]="https://bsc-dataseed.binance.org"
  [polygon]="https://polygon-bor-rpc.publicnode.com"
  [arbitrum]="https://arbitrum-one-rpc.publicnode.com"
  [optimism]="https://optimism-rpc.publicnode.com"
  [base]="https://base-rpc.publicnode.com"
  [sepolia]="https://ethereum-sepolia-rpc.publicnode.com"
  [amoy]="https://polygon-amoy.drpc.org"
  [arbitrum-sepolia]="https://sepolia-rollup.arbitrum.io/rpc"
  [op-sepolia]="https://optimism-sepolia-rpc.publicnode.com"
  [base-sepolia]="https://base-sepolia-rpc.publicnode.com"
  [bsc-testnet]="https://data-seed-prebsc-1-s1.bnbchain.org:8545"
)

start_one() {
  local n="$1" port chain rpc line
  line="${NET[$n]:-}"
  [ -n "$line" ] || { echo "unknown network: $n"; return 1; }
  IFS='|' read -r port chain rpc <<< "$line"
  # Round-robin pair: anvil accepts MULTIPLE --fork-url flags and load-balances
  # across them, rotating to the next endpoint on failure — the built-in answer
  # to CI 36983252072's upstream 429s ("Your IP has exceeded..."), which took
  # down the health gate, the broadcast path AND the live API probes. Two
  # providers = two rate buckets = one of them is usually still open.
  local rpc2="${ALT[$n]:-}"
  # A retry passes its own choice as $2: it becomes the first endpoint, with
  # the original primary kept as the pair so no attempt runs single-handed.
  if [ -n "${2:-}" ]; then rpc2="$rpc"; rpc="$2"; fi
  local fork_args=(--fork-url "$rpc")
  [ -n "$rpc2" ] && fork_args+=(--fork-url "$rpc2")
  # --allow-origin is not optional here. This script exists so the WEB UI can
  # reach these forks, and a browser will not send a JSON-RPC POST until the
  # CORS preflight succeeds. Without the flag anvil does not answer OPTIONS and
  # every request from the page fails as "Failed to fetch" — while curl and any
  # node test keep working, because neither performs a preflight. That asymmetry
  # is what made this look like a flaky app rather than a missing flag.
  anvil --port "$port" --chain-id "$chain" "${fork_args[@]}" \
        --fork-retry-backoff 2 \
        --allow-origin '*' --silent > "$LOG/$n.log" 2>&1 &
  echo $! >> "$PIDFILE"
}

# blockNumber answering is NOT enough — stale/pruned forks still answer it
# while every state read fails. Gate on a real estimateGas (fork-health.mjs).
fork_healthy() {
  (cd "$ROOT" && timeout 25 node tests/fork/fork-health.mjs "$1") >/dev/null 2>&1
}

kill_port() {
  if [ -f "$PIDFILE" ]; then
    local pid newpids=""
    while read -r pid; do
      [ -n "$pid" ] || continue   # blank line → /proc//cmdline noise (see restart_one)
      if [ -d "/proc/$pid" ] && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "--port $1"; then
        kill "$pid" 2>/dev/null || true
      else
        newpids="$newpids $pid"
      fi
    done < "$PIDFILE"
    if [ -n "${newpids# }" ]; then
      printf '%s\n' $newpids | sed 's/^ //' > "$PIDFILE"
    else
      : > "$PIDFILE"
    fi
  fi
}

restart_one() {
  local n="$1"
  [ -n "${NET[$n]:-}" ] || { echo "unknown network: $n"; return 1; }
  local port="${NET[$n]%%|*}"
  # kill only this network's anvil: match the pid serving $port
  local newpids=""
  if [ -f "$PIDFILE" ]; then
    local pid
    while read -r pid; do
      # A blank line makes $pid empty: [ -d "/proc/" ] is TRUE (it is /proc)
      # and the redirect below then reads "/proc//cmdline" and prints
      # "Permission denied" into the log. Skip empties outright.
      [ -n "$pid" ] || continue
      if [ -d "/proc/$pid" ] && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "--port $port"; then
        kill "$pid" 2>/dev/null || true
      else
        newpids="$newpids $pid"
      fi
    done < "$PIDFILE"
    # Empty input makes printf emit ONE blank line, planting exactly the
    # malformed entry the skip above just learned to ignore — truncate instead.
    if [ -n "${newpids# }" ]; then
      printf '%s\n' $newpids | sed 's/^ //' > "$PIDFILE"
    else
      : > "$PIDFILE"
    fi
  fi
  # wait until the port is actually free (old anvil may take a moment to die)
  for i in 1 2 3 4 5 6 7 8; do
    curl -sf -m 1 -X POST -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
      "http://127.0.0.1:$port" >/dev/null 2>&1 || break
    sleep 1
  done
  # drop dead pids so the file never accumulates zombies
  if [ -f "$PIDFILE" ]; then
    local tmp="$PIDFILE.tmp"
    while read -r pid; do [ -d "/proc/$pid" ] && echo "$pid"; done < "$PIDFILE" > "$tmp"
    mv "$tmp" "$PIDFILE"
  fi
  start_one "$n"
  # give the fresh fork time to answer — retry up to ~20s, up to 3 starts
  # (upstream RPCs intermittently 500 "temporary internal error"; a fresh
  # anvil usually gets a healthy one on the next attempt)
  local attempt
  # 4 attempts, worst case ≈ 8s port-wait + 4×(11s curl + 25s health) ≈ 150s —
  # callers budget execFileSync at 180s, so the loop always finishes (and prints
  # its own diagnosis) before the caller kills it blind.
  for attempt in 1 2 3 4; do
    local ok=0
    for i in $(seq 1 7); do
      sleep 1.5
      if curl -sf -m 3 -X POST -H 'content-type: application/json' \
           --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
           "http://127.0.0.1:$port" >/dev/null 2>&1; then
        ok=1; break
      fi
    done
    if [ "$ok" = "1" ]; then
      if fork_healthy "$port"; then
        echo "UP   $n (fresh fork :$port)"
        return 0
      fi
      echo "fork :$port answers but state unhealthy — restarting..."
      kill_port "$port"
    fi
    if [ "$attempt" -lt 4 ]; then
      echo "retrying $n fork start (attempt $attempt of 4)..."
      # odd retries go to the alt upstream, even ones back to primary
      local rpc_try=""
      [ $((attempt % 2)) = 1 ] && [ -n "${ALT[$n]:-}" ] && rpc_try="${ALT[$n]}"
      start_one "$n" "$rpc_try"
    fi
  done
  echo "DOWN $n (fresh fork :$port)"
  return 1
}

case "${1:-start}" in
  stop) stop_all; exit 0 ;;
  restart-one) restart_one "${2:-}"; exit $? ;;
  status)
    [ -f "$PIDFILE" ] || { echo "not running"; exit 0; }
    while read -r pid; do ps -p "$pid" >/dev/null && echo "ALIVE $pid" || echo "DEAD $pid"; done < "$PIDFILE"
    exit 0 ;;
esac

stop_all; sleep 1

for n in "${!NET[@]}"; do
  start_one "$n"
done

sleep 3
echo "started $(wc -l < "$PIDFILE") anvil forks (ports 18545–18556)"
down=0
for n in "${!NET[@]}"; do
  port="${NET[$n]%%|*}"
  if curl -sf -X POST -H 'content-type: application/json' \
       --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
       "http://127.0.0.1:$port" >/dev/null; then
    echo "UP   $n (:$port)"
  else
    echo "DOWN $n (:$port)"; down=$((down+1))
  fi
done
[ "$down" -eq 0 ] || echo "WARNING: $down fork(s) did not answer"