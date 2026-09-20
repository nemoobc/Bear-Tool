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
  [polygon]="18547|137|https://polygon-bor-rpc.publicnode.com"
  [arbitrum]="18548|42161|https://arb1.arbitrum.io/rpc"
  [optimism]="18549|10|https://mainnet.optimism.io"
  [base]="18550|8453|https://mainnet.base.org"
  [sepolia]="18551|11155111|https://sepolia.gateway.tenderly.co"
  [amoy]="18552|80002|https://polygon-amoy.drpc.org"
  [arbitrum-sepolia]="18553|421614|https://arbitrum-sepolia-rpc.publicnode.com"
  [op-sepolia]="18554|11155420|https://sepolia.optimism.io"
  [base-sepolia]="18555|84532|https://sepolia.base.org"
  [bsc-testnet]="18556|97|https://bsc-testnet-rpc.publicnode.com"
)

start_one() {
  local n="$1" port chain rpc line
  line="${NET[$n]:-}"
  [ -n "$line" ] || { echo "unknown network: $n"; return 1; }
  IFS='|' read -r port chain rpc <<< "$line"
  anvil --port "$port" --chain-id "$chain" --fork-url "$rpc" --silent > "$LOG/$n.log" 2>&1 &
  echo $! >> "$PIDFILE"
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
      if [ -d "/proc/$pid" ] && grep -qaF -- "--port $port" "/proc/$pid/cmdline" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      else
        newpids="$newpids $pid"
      fi
    done < "$PIDFILE"
    printf '%s\n' $newpids | sed 's/^ //' > "$PIDFILE"
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
  for attempt in 1 2 3; do
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
      echo "UP   $n (fresh fork :$port)"
      return 0
    fi
    [ "$attempt" -lt 3 ] && echo "retrying $n fork start (attempt $attempt of 3)..." && start_one "$n"
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