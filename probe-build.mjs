// PROBE KYBERSWAP — bukti final: slippageTolerance string vs number, field router vs routerAddress
const KYBER = "https://aggregator-api.kyberswap.com/ethereum/api/v1";
const H = { "Content-Type": "application/json" };
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const AMT = "30000000000000000"; // 0.03 ETH
const SENDER = "0x0000000000000000000000000000000000000001";
const RECIP = SENDER;

async function step(label, url, body){
  const res = await fetch(url, { method:"POST", headers:H, body: JSON.stringify(body) });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0,200) }; }
  return { label, status: res.status, j };
}

function summarize(r){
  const d = r.j?.data;
  const keys = d ? Object.keys(d).join(",") : "(none)";
  console.log(`[${r.label}] HTTP ${r.status} | data keys: ${keys}`);
  if (r.j?.error?.message) console.log(`   error: ${r.j.error.message}`);
  return d;
}

console.log("=== PROBE 1: AMBIL QUOTE DULU ===");
let q;
{
  const url = `${KYBER}/routes?tokenIn=${NATIVE}&tokenOut=${USDC}&amountIn=${AMT}`;
  const res = await fetch(url, { headers:H });
  q = await res.json();
}
const summary = q?.data?.routeSummary;
if (!summary) { console.log("QUOTE GAGAL:", JSON.stringify(q).slice(0,300)); process.exit(1); }
console.log("QUOTE OK — routeSummary punya:", Object.keys(summary?.[0]||{}).join(","));

const U = `${KYBER}/route/build`;

console.log("\n=== PROBE 2: SLIPPAGE STRING('100') vs NUMBER(100) ===");
const sStr = await step("slippage=STRING '100'", U, { routeSummary: summary, sender:SENDER, recipient:RECIP, slippageTolerance:"100" });
const dStr = summarize(sStr);
const sNum = await step("slippage=NUMBER 100", U, { routeSummary: summary, sender:SENDER, recipient:RECIP, slippageTolerance:100 });
const dNum = summarize(sNum);

console.log("\n=== PROBE 3: FIELD router VS routerAddress ===");
for (const [tag, d] of [["(string-ok build)", dStr && dStr.data ? dStr.data : null], ["(number-ok build)", dNum && dNum.data ? dNum.data : null]]) {
  if (!d) continue;
  console.log(`${tag} → router: ${typeof d.router}${d.router!==undefined?` = ${String(d.router).slice(0,12)}...`:""} | routerAddress: ${typeof d.routerAddress}${d.routerAddress!==undefined?` = ${String(d.routerAddress).slice(0,12)}...`:""} | data(calldata): ${d.data ? d.data.slice(0,12)+"..." : "MISSING"}`);
}
