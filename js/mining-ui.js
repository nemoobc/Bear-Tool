// ═══════════════════════════════════════════════════════════════
// Bear Tool — mining-ui.js
// UI wiring for the SHA-256 Proof-of-Work miner (js/mining.js).
// Start/stop, threads, difficulty, live speed + hashes, proof verify.
// ═══════════════════════════════════════════════════════════════

import { $, toast } from './ui.js';
import { makeChallenge, mineChallenge, isValidPoW } from './mining.js';

let controller = null;

export function bindMiningEvents() {
  $('#btnMiningStart')?.addEventListener('click', startMining);
  $('#btnMiningStop')?.addEventListener('click', stopMining);
}

export async function startMining() {
  const addr = $('#miningAddr').value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return toast('Enter a valid wallet address (0x...)', 'error');

  const threads = Math.min(8, Math.max(1, Number($('#miningThreads').value) || 1));
  const difficulty = Math.min(24, Math.max(1, Number($('#miningDifficulty').value) || 4));

  let challenge;
  try {
    challenge = makeChallenge({ difficulty });
  } catch (e) {
    return toast(e?.message || String(e), 'error');
  }
  controller = new AbortController();

  $('#btnMiningStart').disabled = true;
  $('#btnMiningStop').classList.remove('hidden');
  $('#miningStatus').classList.remove('hidden');
  $('#miningState').textContent = 'mining…';
  $('#miningSpeed').textContent = '—';
  $('#miningHashes').textContent = '0';
  $('#miningNonce').textContent = '—';
  $('#miningPrefix').textContent = challenge.prefix;
  $('#miningTarget').textContent = '0x' + challenge.target.toString(16).slice(0, 24) + '…';
  $('#miningProof').textContent = '—';
  $('#miningVerified').textContent = '—';

  try {
    const result = await mineChallenge({
      prefix: challenge.prefix,
      target: challenge.target,
      threads,
      signal: controller.signal,
      onProgress: (p) => {
        $('#miningSpeed').textContent = p.speed.toLocaleString() + ' H/s';
        $('#miningHashes').textContent = p.hashes.toLocaleString();
        $('#miningNonce').textContent = '0x' + p.nonce.toString(16);
      }
    });
    if (controller.signal.aborted) {
      $('#miningState').textContent = 'stopped';
      toast('Mining stopped', 'info');
      return;
    }
    if (!result) {
      $('#miningState').textContent = 'not found in range';
      toast('No nonce found in range — retry', 'error');
      return;
    }
    $('#miningState').textContent = 'proof found ✅';
    $('#miningNonce').textContent = '0x' + result.nonce.toString(16);
    $('#miningProof').textContent = '0x' + result.hash.slice(0, 24) + '…';
    const ok = await isValidPoW({ prefix: challenge.prefix, nonce: result.nonce, target: challenge.target });
    $('#miningVerified').textContent = ok ? '✅ sha256(prefix+nonce) < target' : '❌ invalid';
    toast('Proof of work found! Nonce: 0x' + result.nonce.toString(16), 'success');
  } catch (e) {
    $('#miningState').textContent = 'error';
    toast(e?.message || String(e), 'error');
  } finally {
    $('#btnMiningStart').disabled = false;
    $('#btnMiningStop').classList.add('hidden');
  }
}

export function stopMining() {
  controller?.abort();
  $('#miningState').textContent = 'stopping…';
}