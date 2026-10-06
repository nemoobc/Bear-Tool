// DEPLOY
export default function DeployView() {
  return (
        <section className="view" id="view-deploy">
          {/* ═══════════ OPENSEA ═══════════ */}
          

          {/* ═══════════ WIZARD DEPLOY ═══════════ */}
          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> <span data-i18n="nav.deploy">Wizard Deploy</span></div>
            <div className="deploy-card">
              <div className="field">
                <label htmlFor="deployStandard">Standard</label>
                <select className="select" id="deployStandard">
                  <option value="erc20">ERC-20 (fungible token)</option>
                  <option value="erc721">ERC-721 (NFT)</option>
                  <option value="erc1155">ERC-1155 (multi-token)</option>
                </select>
              </div>
              <div className="deploy-preview" id="deployPreview">
                <div className="deploy-preview-card">
                  <span className="deploy-preview-icon">📄</span>
                  <span className="deploy-preview-text">ERC-20 Token Contract</span>
                </div>
              </div>
              <div className="field">
                <label htmlFor="deployName">Name</label>
                <input className="input" id="deployName" placeholder="My Token" />
              </div>
              <div className="field">
                <label htmlFor="deploySymbol">Symbol</label>
                <input className="input" id="deploySymbol" placeholder="MTK" />
              </div>
              <div id="deployExtra"></div>
              <button type="button" className="btn btn-primary btn-block btn-lg" id="btnDeploy">Deploy Contract</button>
              <div id="deployStatus" className="deploy-status hidden"></div>
              {/* Export row (wizard parity): appears after a successful
                  compile — copy the generated source, keep the .sol, take
                  the ABI. Buttons are plain .btn so no stylesheet grows. */}
              <div id="deployExport" className="deploy-export hidden" role="group" aria-label="Contract export">
                <button type="button" className="btn btn-ghost" data-export="copy-source"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy source</button>
                <button type="button" className="btn btn-ghost" data-export="download-sol">⬇️ Download .sol</button>
                <button type="button" className="btn btn-ghost" data-export="copy-abi"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy ABI</button>
              </div>
              {/* Auto-verify (M10): Sourcify publishes the source with NO key;
                  Etherscan V2 needs one BYO key, and that single key then works
                  on every Etherscan-run explorer (the chainid in the URL picks
                  the chain). Stored in localStorage like the OpenSea key above —
                  a public read key, never a wallet secret. Local chains skip
                  with a reason instead of pretending. */}
              <div className="field">
                <label htmlFor="deployVerifyKey">Etherscan API key (optional — for auto-verify)</label>
                <input className="input" id="deployVerifyKey" type="password" autoComplete="off" spellCheck={false} placeholder="YourApiKeyToken" />
              </div>
            </div>
          </div>

          {/* ═══════════ BATCH CALL ═══════════ */}
          

          {/* ═══════════ RESCUE ATOMIC ═══════════ */}
          

          {/* ═══════════ CLAIM AIRDROP ═══════════ */}
          
        
          {/* EIP-7702 — the standalone "Smart EOA" card (manual delegate to an
              arbitrary implementation) and the "Helper Contracts" status card
              are GONE per user request: every flow now owns its own Deploy
              contract button, and delegation status lives in the topbar badge
              + the Revoke card's Check address. */}

          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg> <span data-i18n="eip7702.batch">Batch Call</span></div>
            <p className="small mb-8">Queue any calls, then Execute in three separate transactions — helper deploy (only if missing), delegation, then execution. Each step reports on its own and the total value is checked against your balance before you confirm. Delegation stays active until you revoke it.</p>
            <div className="batch-queue" id="batchList"></div>
            <button type="button" className="btn btn-ghost mb-8" id="btnBatchAdd">+ Add action</button>
            <div className="flex gap-8 mb-8">
              <button type="button" className="btn btn-secondary" id="btnDeployBatchHelper">Deploy contract</button>
              <button type="button" className="btn btn-primary" id="btnBatchExecute">Execute Batch</button>
            </div>
          </div>

          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> <span data-i18n="eip7702.rescue">Rescue Atomic</span></div>
            <p className="small mb-8">Rescue ERC-20/ERC-721 from a locked wallet. Deploy rescue contract once, target signs authorization, sponsor pays gas and executes the sweep.</p>
            <div className="field">
              <label htmlFor="rescueType">Asset type</label>
              {/* defaultValue di <select>, bukan selected di <option>: React
                  memperingat untuk yang terakhir. defaultValue membuat React
                  menyetel defaultSelected pada opsi — atribut selected="" di
                  DOM, sama persis dengan markup HTML aslinya. ETH-only rescue
                  is dropped per user request (ERC-20 + NFT only). */}
              <select className="input" id="rescueType" defaultValue="erc20">
                <option value="erc20">ERC-20</option>
                <option value="erc721">ERC-721</option>
              </select>
            </div>
            <div className="field" id="rescueTokenWrap">
              <label htmlFor="rescueTokenAddr">Token address</label>
              <input className="input" id="rescueTokenAddr" placeholder="0x..." />
              {/* Paste → identity (ERC-20 / NFT) + the DRAINER's balance */}
              <div className="small" id="rescueTokenDetect" role="status" aria-live="polite" style={{ marginTop: '6px' }}></div>
            </div>
            <div className="field hidden" id="rescueTokenIdWrap">
              <label htmlFor="rescueTokenId">Token ID</label>
              <input className="input" id="rescueTokenId" placeholder="0 or id" />
            </div>
            <div className="field" id="rescueAmountWrap">
              <label htmlFor="rescueAmount">Token amount (ERC-20)</label>
              <div className="input-group">
                <input className="input" id="rescueAmount" placeholder="Amount or MAX" autoComplete="off" />
                <button type="button" className="btn btn-ghost btn-sm" id="btnRescueMax">MAX</button>
              </div>
              <div className="small">Manual amount, or MAX to fill the wallet's full balance.</div>
            </div>
            <div className="field">
              <label htmlFor="rescueSponsorFrom">Sponsor wallet</label>
              <select className="input" id="rescueSponsorFrom">
              </select>
              <div className="small">Options fill from your saved wallets — pick any to sponsor from it.</div>
            </div>
            {/* Helper contract control, per user request: the standalone
                Helper Contracts card is gone, so each flow carries its own
                Deploy button. The address box is OPTIONAL — paste an existing
                rescue contract and it is probed on-chain (code + SAFE/RESCUER
                deployer) before use; a mismatch with this flow's SAFE/sponsor
                asks "deploy baru?" instead of silently reusing a helper that
                can only revert (onlyRescuer). Empty = registry auto-lookup. */}
            <div className="field">
              <label htmlFor="rescueHelperAddr">Contract address (optional — paste to reuse an existing rescue contract)</label>
              <input className="input" id="rescueHelperAddr" placeholder="0x… (empty = auto / deploy)" spellCheck="false" autoComplete="off" />
              <div className="small" id="rescueHelperDetect" role="status" aria-live="polite" style={{ marginTop: '6px' }}></div>
            </div>
            <button type="button" className="btn btn-secondary btn-block mb-8" id="btnDeployRescueHelper">Deploy contract</button>
            <div className="field">
              <label htmlFor="rescueTargetKey">Target private key (required — rescue deploys against this key)</label>
              <div className="input-group">
                <input className="input" type="password" id="rescueTargetKey" placeholder="0x..." autoComplete="off" />
                <button type="button" className="btn btn-ghost btn-sm" id="btnRescueTargetKeyToggle" aria-label="Show target key" aria-pressed="false"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="rescueSafe">SAFE destination address</label>
              <input className="input" id="rescueSafe" placeholder="0x..." />
            </div>
            <button type="button" className="btn btn-secondary btn-block" id="btnRescue">Rescue Assets</button>
          </div>

          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12v10H4V12"/><path d="M2 7h20v5H2z"/><path d="M12 22V7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg> <span data-i18n="eip7702.claim">Claim Airdrop</span></div>
            <p className="small mb-8">Paste the claim calldata and a SAFE to forward rewards to — if the claimer helper is missing, the flow asks and deploys it right there (reused next time). The sponsor pays gas; delegation stays active until you revoke it.</p>
            <div className="field">
              <label htmlFor="claimContract">Claim contract address</label>
              <input className="input" id="claimContract" placeholder="0x..." />
            </div>
            <div className="field">
              <label htmlFor="claimData">Claim data (hex)</label>
              <input className="input" id="claimData" placeholder="0x..." />
            </div>
            <div className="field">
              <label htmlFor="claimToken">Token address (ERC-20, required)</label>
              <input className="input" id="claimToken" placeholder="0x..." />
              <div className="small" id="claimTokenDetect" role="status" aria-live="polite" style={{ marginTop: '6px' }}></div>
            </div>
            <div className="field">
              <label htmlFor="claimAmount">Amount to claim (minimum granted on-chain)</label>
              <input className="input" id="claimAmount" placeholder="e.g. 100" autoComplete="off" />
              <div className="small">If the claim lands below this, the whole transaction reverts — funds never move halfway.</div>
            </div>
            <div className="field">
              <label htmlFor="claimSafe">Forward to SAFE</label>
              <input className="input" id="claimSafe" placeholder="0x..." />
            </div>
            <div className="field">
              <label htmlFor="claimTargetKey">Target private key (optional — active wallet if empty)</label>
              <input className="input" type="password" id="claimTargetKey" placeholder="0x..." autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="claimSponsorFrom">Sponsor wallet</label>
              <select className="input" id="claimSponsorFrom">
              </select>
              <div className="small">Options fill from your saved wallets — pick any to sponsor from it.</div>
            </div>
            <button type="button" className="btn btn-secondary btn-block mb-8" id="btnDeployAirdropClaimer">Deploy contract</button>
            <button type="button" className="btn btn-success btn-block" id="btnClaim">Claim + Forward</button>
            <div id="claimResult" className="small claim-result hidden" style={{ marginTop: '10px' }} role="status"></div>
          </div>

          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg> <span data-i18n="eip7702.revokeTitle">Revoke EIP-7702 Delegation</span></div>
            <p className="small mb-8">Remove a delegation from an EOA (back to plain EOA). Works for the active wallet, or any wallet whose private key you hold. A malicious delegation = total compromise — revoke it immediately.</p>
            <div className="field">
              <label htmlFor="revokeTarget">Check address (delegation)</label>
              {/* Auto-filled with the detected (active) address on load — the
                  check reads THIS address's delegation only; the sponsor is
                  just the gas payer. */}
              <input className="input" id="revokeTarget" placeholder="0x… (auto: current wallet)" data-auto-fill="address" />
            </div>
            <div className="field">
              <label htmlFor="revokeKey">Private key (optional — only if target is not the active wallet)</label>
              <input className="input" id="revokeKey" type="password" placeholder="0x..." />
            </div>
            <div className="field">
              <label htmlFor="revokeSponsorFrom">Sponsor wallet</label>
              <select className="input" id="revokeSponsorFrom">
              </select>
              <div className="small">The sponsor pays gas and broadcasts; the target signs the authorization.</div>
            </div>
            <div className="flex gap-8">
              <button type="button" className="btn btn-ghost" id="btnCheckDelegation">Check delegation</button>
              <button type="button" className="btn btn-danger" id="btnRevokeDelegation">Revoke delegation</button>
            </div>
            <div id="revokeStatus" className="delegate-status eoa hidden" style={{ marginTop: '12px' }}>
              <span className="label">Status:</span>
              <span id="revokeStatusText">—</span>
            </div>
          </div>

          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> <span data-i18n="eip7702.contracts">Deployed Contracts</span> <span className="small" data-i18n="eip7702.contractsOn">on this chain</span></div>
            <p className="small mb-8">Helper contracts deployed via EIP-7702 flows are saved here and reused to save gas. Remove an entry to force a fresh deploy.</p>
            <div id="deployedRegistryList" className="registry-list"></div>
          </div>
        <div className="card">
            <div className="card-title">🌊 OpenSea</div>
            <div className="opensea-panel" id="openSeaPanel">

              {/* Guide first. The API key is the one value a new user cannot
                   infer, so it is step 1 rather than a footnote. */}
              <details className="os-guide" id="openSeaGuide" open>
                <summary><span aria-hidden="true">📖</span> <span data-i18n="os.guide.title">Mulai di sini &mdash; 3 langkah</span></summary>
                <ol className="os-steps">

                  <li>
                    <div className="os-step-h"><span className="os-step-n">1</span> <span data-i18n="os.guide.s1">Buat API key gratis dari OpenSea</span></div>
                    <p className="small dim" data-i18n="os.guide.s1d">Buka app.opensea.io/settings/api-keys &rarr; <em>My API Keys</em> &rarr; <em>Create</em>, lalu salin key-nya ke kotak di bawah. Key disimpan hanya di browser ini, tidak pernah dikirim ke server kami.</p>
                    <div className="field">
                      <label htmlFor="openSeaApiKey"><span data-i18n="os.guide.s1l">OpenSea API key</span> <span className="req" data-i18n="os.req">wajib</span></label>
                      <div className="os-key-row">
                        <input className="input" id="openSeaApiKey" type="password" autoComplete="off" placeholder="paste key…" data-i18n-placeholder="os.ph.key" aria-describedby="openSeaKeyState" />
                        <button className="btn btn-sm btn-secondary" type="button" id="btnRevealOsKey" aria-pressed="false" title="Show / hide key">👁</button>
                        <button className="btn btn-sm btn-secondary" type="button" id="btnTestOsKey" data-i18n="os.guide.testkey">Test</button>
                      </div>
                      <p className="small dim" id="openSeaKeyState" role="status" data-i18n="os.guide.nokey">Belum ada key tersimpan.</p>
                    </div>
                  </li>

                  <li>
                    <div className="os-step-h"><span className="os-step-n">2</span> <span data-i18n="os.guide.s2">Tempel link koleksi, slug, atau alamat kontrak</span></div>
                    <p className="small dim" data-i18n="os.guide.s2d">Salah satu saja cukup &mdash;_example_: <code>opensea.io/collection/cryptopunks</code> &middot; <code>cryptopunks</code> &middot; <code>0xBC4C…f13D</code></p>
                    <div className="field">
                      <label htmlFor="openSeaContract" data-i18n="os.field.collection">Koleksi (link / slug / address)</label>
                      <input className="input" id="openSeaContract" placeholder="opensea.io/collection/… atau 0x… atau slug" data-i18n-placeholder="os.ph.collection" spellCheck="false" autoComplete="off" />
                    </div>
                  </li>

                  <li>
                    <div className="os-step-h"><span className="os-step-n">3</span> <span data-i18n="os.guide.s3">Masukkan wallet, lalu tekan tombol hijau</span></div>
                    <p className="small dim" data-i18n="os.guide.s3d">Kosongkan saja kalau wallet sudah terhubung. Kalau wallet terdaftar sebagai holder, muncul harga ask + gas + total + daftar sinyal keamanan. Kalau tidak, tampil sebatas itu saja.</p>
                    <div className="field">
                      <label htmlFor="openSeaWlAddress" data-i18n="os.field.wladdr">Wallet untuk cek eligibility</label>
                      <input className="input" id="openSeaWlAddress" placeholder="0x… (kosong = wallet aktif)" data-i18n-placeholder="os.ph.wallet" spellCheck="false" autoComplete="off" />
                    </div>
                    <button type="button" className="btn btn-sm btn-primary" id="btnCheckWL" data-i18n="os.btn.check">✔ Cek eligibility</button>
                  </li>

                </ol>
              </details>

              {/* Market actions are contract calls, not a check, so they sit
                   behind a disclosure. Ids unchanged for the guarding suites. */}
              <details className="os-advanced" id="openSeaAdvanced">
                <summary data-i18n="os.adv.title">Jual / batalkan NFT (opsional)</summary>
                <div className="field">
                  <label htmlFor="openSeaTokenId" data-i18n="os.field.tokenid">Token ID</label>
                  <input className="input" id="openSeaTokenId" type="number" placeholder="e.g. 1234" data-i18n-placeholder="os.ph.tokenid" />
                </div>
                <div className="field">
                  <label htmlFor="openSeaPrice" data-i18n="os.field.listprice">List price (ETH)</label>
                  <input className="input" id="openSeaPrice" type="number" step="0.001" placeholder="0.1" />
                </div>
                <div className="opensea-bar">
                  <button type="button" className="btn btn-sm btn-secondary" id="btnOpenSeaList" data-i18n="os.btn.list">List NFT</button>
                  <button type="button" className="btn btn-sm btn-danger" id="btnOpenSeaCancel" data-i18n="os.btn.cancel">Cancel Listing</button>
                  <button type="button" className="btn btn-sm btn-success" id="btnAcceptTopOffer" data-i18n="os.btn.accept">Accept Top Offer</button>
                </div>
              </details>

              <div id="openSeaStatus" className="opensea-status" style={{ marginTop: '8px' }} role="status" aria-live="polite"></div>
            </div>
          </div>

          {/* OpenSea market actions: listing, cancelling and accepting an offer
               are contract calls against the wallet, so they live with the Tools
               view rather than the gallery. */}
        </section>
  );
}
