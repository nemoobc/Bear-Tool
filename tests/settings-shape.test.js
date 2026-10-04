// Settings is a shape, not a preference: how it looks, how long it holds a
// key, and the delete — and the delete ends the page. That shape is only worth
// anything if something measures it, because the page used to be 2500px with
// the delete buried in the middle of six sections of Security Center and a
// second copy of the same delete button at the very bottom.
//
// It is now six sections, not five, and the sixth was added on request: an
// EIP-7702 capability check. Two things about it keep the original rule alive
// anyway. The count is no longer the rule — the rule is that everything here
// is something a person opens Settings to FIND OUT or change, and the check
// is exactly that (a question about the chains, answerable in place). And the
// group sits BEFORE the delete, so the irreversible button is still the last
// thing on the page, which is what the count was protecting all along.
//
// The second half of this file is the part that matters more. Moving the
// Security Center out of Settings silently destroyed the ONLY route a phone had
// to the Approvals view: the link that lived inside it. Nothing broke. No test
// failed. No console error. A feature simply stopped existing on the device
// most people would use it on, and nothing said so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appSource } from './helpers/app-source.mjs';

// Halaman = index.html + section view (M2: src/views/*.jsx).
const html = appSource();
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const sec = readFileSync(new URL('../js/security-center.js', import.meta.url), 'utf8');

/** The markup of one <section class="view">, by id. */
function view(id) {
  const at = html.indexOf(`id="view-${id}"`);
  assert.ok(at > -1, `view-${id} must exist in the page markup (index.html + src/views)`);
  const end = html.indexOf('</section>', at);
  return html.slice(at, end);
}

test('Settings holds the five things it always had, plus the check, in four groups', () => {
  const v = view('settings');
  for (const id of ['setLang', 'setCurrency', 'setAutoLock', 'setTestnet', 'btnClearAllData', 'btn7702Check']) {
    assert.ok(v.includes(`id="${id}"`), `#${id} must be in Settings`);
  }
  // Theme is a button group rather than a select, so it has no id of its own.
  assert.match(v, /Theme/, 'Theme must be in Settings');
  // Four groups: Appearance (language, currency, theme), Safety (auto-lock,
  // testnet mode), EIP-7702 support (asked for by name), and the delete alone
  // in its own group. The delete is separated rather than stacked because it
  // is the one irreversible thing on the page and it should read as a
  // conclusion, not as another preference.
  assert.equal((v.match(/class="set-group[ "]/g) || []).length, 4);
  assert.equal((v.match(/set-group-h/g) || []).length, 4);
  // And the check sits before the delete, not after it — the ordering rule
  // below is the one the "five things" count was standing in for.
  assert.ok(v.indexOf('id="btn7702Check"') < v.indexOf('id="btnClearAllData"'),
    'the check must not push the delete out of last place');
});

test('there is no Save button, and no dead control standing in for one', () => {
  const v = view('settings');
  assert.ok(!v.includes('btnSaveSettings'),
    'every setting applies on change; a Save button that no longer saves is worse than none');
  // The pattern that actually bit: a control that still binds to something.
  // btn7702Check and eip7702Results belong here because they are the opposite
  // of the thing this test hunts: the button is bound to runEip7702Check and
  // the div is filled by it (both pinned in eip7702-approval-ui.test.js), so
  // neither is a Save button wearing a working button's clothes.
  const ALLOWED = ['setLang', 'setCurrency', 'setAutoLock', 'setTestnet', 'btnClearAllData',
    'btn7702Check', 'eip7702Results'];
  const dead = [...v.matchAll(/id="(\w+)"[^>]*>\s*(?:<[^>]+>\s*)*[A-Za-z]/g)]
    .filter(([, id]) => !ALLOWED.includes(id));
  assert.equal(dead.length, 0, `unexpected controls in Settings: ${dead.map((d) => d[1]).join(', ')}`);
});

test('the testnet switch is in Settings AND in the picker, on one writer', () => {
  // It was in Settings, then it was moved out, then it was reported missing from
  // Settings and put back. Two controls for one setting is the shape that drifts:
  // one gets flipped and the other keeps asserting the old value, so the page
  // contradicts the app. The rule that makes that impossible is that the
  // setting has exactly ONE writer and both switches only read back from it.
  assert.ok(view('settings').includes('id="setTestnet"'), 'Settings must have the testnet switch');
  assert.match(app, /id="netShowTestnet"/, 'the picker keeps its copy, beside the list it filters');

  const writer = /function setTestnetVisible\(on, redraw\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(writer, 'there must be one named function that owns settings.testnet');
  // The single writer must be the ONLY place the setting is assigned. A second
  // assignment is a second opinion, and one of the two will eventually be wrong.
  const assignments = [...app.matchAll(/settings\.testnet\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(assignments, ['on'],
    `settings.testnet must be written in exactly one place, found: ${assignments.join(' | ')}`);

  // Both switches must go through it, never through their own copy of the logic.
  assert.match(app, /\$\('#setTestnet'\)\?\.addEventListener\('change',[\s\S]{0,120}setTestnetVisible\(/,
    'the Settings switch must call the shared writer');
  assert.match(app, /\$\('#netShowTestnet'\)\?\.addEventListener\('change',[\s\S]{0,140}setTestnetVisible\(/,
    'the picker switch must call the same writer');

  // And both must be re-read from storage, or a switch can boot showing a state
  // the app does not hold — which is the original bug: the knob moved, the
  // setting stayed, and only a Save button ever made them agree.
  assert.match(app, /function syncTestnetSwitches\(\)/, 'both switches read back from one place');
  assert.match(app, /syncTestnetSwitches\(\);\s*\n/, 'and it must run when the page is bound');
  assert.equal((app.match(/\$\('#setTestnet'\)/g) || []).length >= 1, true);
  for (const id of ['#setTestnet', '#netShowTestnet']) {
    assert.ok(new RegExp(`\\$\\('${id}'\\)`).test(app), `${id} must be reachable from the sync`);
  }
});

test('the switch is a pill with a centred knob, not a circle', () => {
  // The touch floor is min-height, and min-height beats height. A 26px track
  // that was also the tap target therefore became 48×44 on a phone, and
  // border-radius:999px on a box that tall renders a CIRCLE — with the 20px
  // knob stranded at top:3px. It was reported as "still buggy" after the
  // control was put back, because the rule that made it thumb-sized was the
  // reason it looked broken.
  const css = readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('.switch {'));
  const slider = css.slice(css.indexOf('.switch .slider {'));

  // The track must be shorter than the target, or they are the same box again.
  const trackH = /height:\s*(\d+)px/.exec(slider.slice(0, slider.indexOf('}')))[1];
  assert.ok(Number(trackH) < 44, `the drawn track must be smaller than the 44px target, got ${trackH}px`);
  assert.match(block, /height:\s*var\(--touch-min\)/, 'the target carries the touch floor');
  // A pill needs height well under width; 48×28 is the iOS proportion.
  assert.ok(Number(trackH) / 48 < 0.65, `track ${trackH}/48 is too square to read as a pill`);
  // The knob centres itself rather than sitting at a magic offset from the top,
  // so a change to the track height cannot strand it.
  assert.match(slider, /\.switch \.slider::before[\s\S]*?top:\s*50%/, 'the knob is vertically centred');
  assert.match(slider, /\.switch \.slider::before[\s\S]*?margin-top:\s*-10px/,
    'and centred by its own half-height, leaving :checked free to own translateX');
  assert.match(slider, /:checked \+ \.slider::before \{ transform: translateX\((\d+)px\)/,
    'the checked state must be a plain X translation');
  const travel = Number(/translateX\((\d+)px\)/.exec(slider)[1]);
  assert.ok(travel > 0 && travel + 20 <= 48, `the knob must travel inside the 48px track, got ${travel}px`);
});

test('hiding testnets cannot strand the wallet on a hidden chain', () => {
  // The failure this guards: testnets off while standing on Sepolia leaves the
  // app pointed at a chain that nothing lists any more, and the network pill
  // shows a chain you cannot get back to from any list.
  const w = /function setTestnetVisible[\s\S]*?\n\}/.exec(app)[0];
  assert.match(w, /active\?\.type === 'testnet'/, 'it must notice the active chain is a testnet');
  assert.match(w, /set\('networkId', 'ethereum'\)/, 'and move to Ethereum before hiding them');
  // The lookup must use the UNFILTERED list, or it can never see the testnet it
  // is about to hide and the move silently does not happen.
  assert.match(w, /\[\.\.\.NETWORKS, \.\.\.getCustomNetworks\(\)\]/,
    'look the active chain up unfiltered — the filtered list cannot see what it just hid');
});

test('the delete is the last element of the Settings page, with nothing under it', () => {
  // Ordering, not CSS: a group added after this one pushes the irreversible
  // button back into the middle of a page, which is the exact complaint.
  const v = view('settings');
  const groups = [...v.matchAll(/class="set-group[^"]*"/g)].map((m) => m.index);
  const deleteAt = v.indexOf('id="btnClearAllData"');
  assert.ok(groups.length >= 1, 'there must be at least one group');
  assert.equal(groups[groups.length - 1], v.lastIndexOf('class="set-group'),
    'the delete sits in the last group — a group added after it would bury it again');
  assert.ok(deleteAt > groups[groups.length - 1], 'and the button is inside that last group');
  assert.ok(v.indexOf('id="securityCenter"') === -1,
    'the Security Center must not be part of Settings; it is what made this page 2500px');
  assert.equal((v.match(/btn-danger/g) || []).length, 1, 'one delete, not two');
});

test('the Security Center renders in the Approvals view, not in Settings', () => {
  assert.ok(view('approval').includes('id="securityCenter"'),
    'the Center belongs beside the approval scanner — both answer "what can a dApp take from me"');
  // The switch to a block was deliberate: opening the view now runs the
  // approval scan as well, so the single-line form is gone. What must survive
  // is the binding itself — a Center whose div never gets painted is the same
  // silent death as a route nobody can reach.
  assert.match(app, /if \(view === 'approval'\) \{[\s\S]{0,260}renderSecurityCenter\(\$\('#securityCenter'\)\)/,
    'and it must be rendered when THAT view opens, or the div stays empty');
  // The link it used to hold pointed at the view it now lives inside, so it was
  // removed. A button that navigates to the page you are already on is a dead
  // control wearing a working one's clothes.
  assert.ok(!sec.includes('secGoApprovals'), 'the self-referential Approvals link must be gone');
});

test('every view a phone cannot see in the bar still has a way in', () => {
  // REACHABLE_ON_MOBILE is a comment claiming each view is reachable. This
  // checks the claim against the markup, which is the only thing that can catch
  // a route that was deleted instead of moved.
  // split('\n'), not [...string]: spreading a string iterates CHARACTERS, which
  // silently yields zero matches and reads as "no routes declared" — a test that
  // fails for a reason that has nothing to do with the thing it checks.
  const block = app.slice(app.indexOf('const REACHABLE_ON_MOBILE'));
  const routes = block.slice(0, block.indexOf('};')).split('\n')
    .map((line) => /^\s*(\w+):\s*'([^']+)'/.exec(line))
    .filter(Boolean)
    .map(([, view, how]) => ({ view, how }));
  assert.ok(routes.length >= 5, `expected every non-bar view listed, got ${routes.length}`);

  for (const { view: v, how } of routes) {
    // A route described as a Dashboard quick action must BE a quick action.
    if (/Dashboard quick action/.test(how)) {
      assert.ok(html.includes(`class="quick-action-btn" data-view="${v}"`),
        `${v} is documented as reachable from a Dashboard quick action, but no such button exists — ` +
        'this is how the only phone route to Approvals was destroyed without a single error');
    }
    // Every view must be one switchView can actually open.
    assert.match(app, new RegExp(`'${v}'`), `${v} must be a view the app knows`);
    assert.ok(html.includes(`id="view-${v}"`), `#view-${v} must exist`);
  }
});

test('the five bottom-bar slots are the ones the design chose', () => {
  const m = /const MOBILE_PRIMARY = \[([^\]]+)\]/.exec(app);
  assert.ok(m, 'MOBILE_PRIMARY must exist');
  const slots = [...m[1].matchAll(/'([\w-]+)'/g)].map((x) => x[1]);
  assert.deepEqual(slots, ['dashboard', 'activity', 'swap', 'dapps', 'settings']);
  // And each one must have a real sidebar item to copy the label and icon from.
  for (const s of slots) {
    assert.ok(html.includes(`data-view="${s}"`), `no sidebar item for ${s}`);
  }
});

test('EIP-7702 scan: tombol delete logs muncul setelah scan (markup + wiring)', () => {
  const v = view('settings');
  assert.ok(v.includes('id="btnClearLogs"'), '#btnClearLogs must live in the EIP-7702 group');
  assert.match(v, /id="btnClearLogs"[^>]*hidden/,
    'button starts hidden — it appears only after the scan finishes');
  assert.ok(v.indexOf('id="btnClearLogs"') < v.indexOf('id="btnClearAllData"'),
    'the logs button must not push the irreversible delete out of last place');
  assert.equal((v.match(/class="set-group[ "]/g) || []).length, 4,
    'no new settings group — the button joins the EIP-7702 group');
  assert.ok(app.includes('btnClearLogs'), 'app.js must reveal the button after the scan');
  assert.ok(app.includes('clearLogs'), 'app.js must call clearLogs() on click');
});
