#!/usr/bin/env bash
# run-fork-all.sh — fork lokal mainnet + testnet ALL (12 network), 4 paralel.
set -u
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")" || exit 1
mkdir -p logs
NETWORKS="ethereum bsc polygon arbitrum optimism base sepolia amoy arbitrum-sepolia optimism-sepolia base-sepolia bsc-testnet"
run_net() {
  local n="$1" port="$2"
  {
    echo "=== [$n] fork start $(date +%T) ==="
    FORK_NETWORK="$n" FORK_PORT="$port" timeout 900 npm run test:fork:net 2>&1
    echo "EXIT($n):$?"
  } > "logs/fork-$n.log" 2>&1
}
i=0
for n in $NETWORKS; do
  port=$((8545 + (i % 4)))
  run_net "$n" "$port" &
  i=$((i+1))
  if [ $((i % 4)) -eq 0 ]; then wait; fi
done
wait
echo "ALL_FORK_DONE"
grep -h "EXIT(" logs/fork-*.log | sort