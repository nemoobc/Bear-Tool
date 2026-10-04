#!/usr/bin/env bash
# Re-measure deBridge DLN (api.dln.trade) — five probes, 2026-10-03.
# Rule: 400 = alive, 401/403 = needs key, 000 = dead (retry), HTML-not-JSON = no builder.
# Evidence: body_dln1..5 + status.txt in this directory.
set -u
cd "$(dirname "$0")"
UA='Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36'
ORG='https://app.debridge.finance'
: > status.txt

probe() { # probe <n> <curl args...>
  n="$1"; shift
  code=$(curl -sS -o "body_dln$n" -w '%{http_code}' -A "$UA" -H "Origin: $ORG" -H 'Accept: application/json' "$@")
  size=$(wc -c < "body_dln$n")
  echo "$n: HTTP $code / $size bytes" >> status.txt
}

probe 1 "https://api.dln.trade/v1/chainPairs?fromChain=1&toChain=56"
probe 2 "https://api.dln.trade/v1/quote?fromChain=1&toChain=56&fromToken=0x0000000000000000000000000000000000000000&toToken=0x0000000000000000000000000000000000000000&amount=100000000000000000&takeIsUserBeneficiary=true&enableEstimate=true"
probe 3 "https://api.dln.trade/v1/order-book?srcChain=1&dstChain=56&srcTokenAddress=0x0000000000000000000000000000000000000000&dstTokenAddress=0x0000000000000000000000000000000000000000&amount=100000000000000000"
probe 4 -X POST -H 'Content-Type: application/json' \
  -d '{"srcChain":1,"dstChain":56,"srcToken":"0x0000000000000000000000000000000000000000","dstToken":"0x0000000000000000000000000000000000000000","amount":"100000000000000000"}' \
  "https://api.dln.trade/v1/quote"
# (5) same as 2 but over HTTP/2
code=$(curl -sS --http2 -o body_dln5 -w '%{http_code}' -A "$UA" -H "Origin: $ORG" -H 'Accept: application/json' \
  "https://api.dln.trade/v1/quote?fromChain=1&toChain=56&fromToken=0x0000000000000000000000000000000000000000&toToken=0x0000000000000000000000000000000000000000&amount=100000000000000000")
size=$(wc -c < body_dln5)
echo "5: HTTP $code / $size bytes" >> status.txt

cat status.txt
