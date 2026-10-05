// ═══════════════════════════════════════════════════════════════
// Bear Tool — eip7702.js
// The standalone Smart EOA card (manual delegate/revoke form) was
// removed per user request (2026-10-04). What remains:
//   - loadEip7702(): refresh the deployed-contract registry when the
//     Tools view opens (app.js calls it on view switch).
//   - Delegation auto-detect → topbar badge (updateDelegationBadge
//     in app.js) + the Revoke card's "Check address (delegation)".
// Batch/rescue/claim delegate automatically inside their flows
// (delegateAndExecute in eip7702-tools.js); revoke lives on the
// Revoke card (#btnRevokeDelegation → revokeDelegation()).
// Exactly one binding per button — the old stubs are gone (M4).
// ═══════════════════════════════════════════════════════════════

import { renderDeployedRegistry } from './eip7702-tools.js';

export async function loadEip7702() {
  renderDeployedRegistry();
}
