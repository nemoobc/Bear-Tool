// ═══════════════════════════════════════════════════════════════
// Bear Tool — i18n.js
// EN/ID translations + t() helper + __() interpolation.
// ═══════════════════════════════════════════════════════════════

const TRANSLATIONS = {
  en: {
    'nav.dashboard': 'Dashboard',
    'nav.send': 'Send',
    'nav.swap': 'Swap',
    'nav.bridge': 'Bridge',
    'nav.eip7702': 'EIP-7702',
    'nav.approval': 'Approvals',
    'nav.deploy': 'Deploy',
    'nav.activity': 'Activity',
    'nav.settings': 'Settings',
    'dashboard.assets': 'My Assets',
    'dashboard.nfts': 'NFTs',
    'dashboard.no_assets': 'Connect or create a wallet to see your assets.',
    'dashboard.no_nfts': 'No NFTs yet.',
    'send.title': '✈️ Send',
    'send.to': 'To address',
    'send.token': 'Token',
    'send.amount': 'Amount',
    'send.gas': 'Gas speed',
    'send.max': 'MAX',
    'send.send': 'Send',
    'swap.title': '🔄 Swap',
    'swap.from': 'From',
    'swap.to': 'To',
    'swap.slippage': 'Slippage',
    'swap.get_quote': 'Get Quote',
    'bridge.title': '🌉 Bridge',
    'bridge.from_chain': 'From chain',
    'bridge.to_chain': 'To chain',
    'bridge.token': 'Token',
    'bridge.amount': 'Amount',
    'bridge.get_route': 'Get Route',
    'eip7702.title': '⚡ EIP-7702 — Smart EOA',
    'eip7702.delegate': 'Delegate',
    'eip7702.revoke': 'Revoke',
    'eip7702.batch': '🧩 Batch Call (atomic)',
    'eip7702.rescue': '🛟 Rescue Atomic',
    'eip7702.claim': '🎁 Claim Airdrop',
    'approval.title': '🔐 Approval Manager',
    'approval.scan': 'Scan Approvals',
    'deploy.title': '🧙 Wizard Deploy',
    'deploy.deploy': 'Deploy Contract',
    'activity.title': '📜 Activity',
    'activity.empty': 'No transactions yet.',
    'settings.title': '⚙️ Settings',
    'settings.currency': 'Currency',
    'settings.language': 'Language',
    'settings.auto_lock': 'Auto-lock (minutes)',
    'settings.rpc': 'Custom RPC URL (optional)',
    'settings.save': 'Save Settings',
    'settings.clear': '🗑️ Clear all data',
    'common.loading': 'Loading...',
    'common.cancel': 'Cancel',
    'common.confirm': 'Confirm',
    'common.error': 'Error: {{message}}',
    'welcome.title': 'Welcome to Bear Tool! 🍯',
    'welcome.desc': 'Self-custody wallet. Your keys never leave this browser.',
    'welcome.create': '🐻 Create Wallet',
    'welcome.import': '📥 Import',
    'unlock.title': 'Welcome back! 🐻',
    'unlock.button': 'Unlock',
    'locked.title': 'Auto-locked 🔒'
  },
  id: {
    'nav.dashboard': 'Dasbor',
    'nav.send': 'Kirim',
    'nav.swap': 'Tukar',
    'nav.bridge': 'Bridge',
    'nav.eip7702': 'EIP-7702',
    'nav.approval': 'Persetujuan',
    'nav.deploy': 'Deploy',
    'nav.activity': 'Aktivitas',
    'nav.settings': 'Pengaturan',
    'dashboard.assets': 'Aset Saya',
    'dashboard.nfts': 'NFT',
    'dashboard.no_assets': 'Hubungkan atau buat dompet untuk melihat aset.',
    'dashboard.no_nfts': 'Belum ada NFT.',
    'send.title': '✈️ Kirim',
    'send.to': 'Alamat tujuan',
    'send.token': 'Token',
    'send.amount': 'Jumlah',
    'send.gas': 'Kecepatan gas',
    'send.max': 'MAKS',
    'send.send': 'Kirim',
    'swap.title': '🔄 Tukar',
    'swap.from': 'Dari',
    'swap.to': 'Ke',
    'swap.slippage': 'Slippage',
    'swap.get_quote': 'Dapatkan Kutipan',
    'bridge.title': '🌉 Bridge',
    'bridge.from_chain': 'Dari chain',
    'bridge.to_chain': 'Ke chain',
    'bridge.token': 'Token',
    'bridge.amount': 'Jumlah',
    'bridge.get_route': 'Dapatkan Rute',
    'eip7702.title': '⚡ EIP-7702 — EOA Cerdas',
    'eip7702.delegate': 'Delegasi',
    'eip7702.revoke': 'Cabut',
    'eip7702.batch': '🧩 Panggilan Batch (atomik)',
    'eip7702.rescue': '🛟 Selamatkan Atomik',
    'eip7702.claim': '🎁 Klaim Airdrop',
    'approval.title': '🔐 Manajer Persetujuan',
    'approval.scan': 'Pindai Persetujuan',
    'deploy.title': '🧙 Wizard Deploy',
    'deploy.deploy': 'Deploy Kontrak',
    'activity.title': '📜 Aktivitas',
    'activity.empty': 'Belum ada transaksi.',
    'settings.title': '⚙️ Pengaturan',
    'settings.currency': 'Mata uang',
    'settings.language': 'Bahasa',
    'settings.auto_lock': 'Kunci otomatis (menit)',
    'settings.rpc': 'URL RPC kustom (opsional)',
    'settings.save': 'Simpan Pengaturan',
    'settings.clear': '🗑️ Hapus semua data',
    'common.loading': 'Memuat...',
    'common.cancel': 'Batal',
    'common.confirm': 'Konfirmasi',
    'common.error': 'Kesalahan: {{message}}',
    'welcome.title': 'Selamat Datang di Bear Tool! 🍯',
    'welcome.desc': 'Dompet self-custody. Kunci Anda tidak pernah keluar dari browser ini.',
    'welcome.create': '🐻 Buat Dompet',
    'welcome.import': '📥 Impor',
    'unlock.title': 'Selamat Datang Kembali! 🐻',
    'unlock.button': 'Buka Kunci',
    'locked.title': 'Terkunci otomatis 🔒'
  }
};

let currentLang = 'en';

// interpolate {{param}} in a template string
export function __(template, params = {}) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (m, k) =>
    (params[k] !== undefined && params[k] !== null) ? String(params[k]) : m
  );
}

// translate a key, interpolating params
export function t(key, params = {}) {
  const dict = TRANSLATIONS[currentLang] || TRANSLATIONS.en;
  const str = dict[key] ?? TRANSLATIONS.en[key] ?? key;
  return __(str, params);
}

export function setLang(lang) {
  currentLang = TRANSLATIONS[lang] ? lang : 'en';
  try { localStorage.setItem('bear.lang', currentLang); } catch {}
  applyTranslations();
  return currentLang;
}

export function getLang() {
  return currentLang;
}

// scan [data-i18n] / [data-i18n-placeholder] and apply translations
export function applyTranslations() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}