import { supabase, configOk, DB_SCHEMA, REQUIRED_DOMAIN, signInWithGoogle, checkDomainOrSignOut } from './supabase-client.js';

const boardEl = document.getElementById('board');
const updatedEl = document.getElementById('last-updated');

const noticeEl = document.getElementById('notice');
const signedOutCardEl = document.getElementById('signed-out-card');
const signInLinkEl = document.getElementById('sign-in-link');
const userEmailEl = document.getElementById('user-email');
const signOutBtn = document.getElementById('sign-out');

const statusWrapEl = document.getElementById('status-wrap');
const statusToggleBtns = Array.from(document.querySelectorAll('.status-toggle'));
const statusCustomToggleBtn = document.getElementById('status-custom-toggle');
const statusCustomInputEl = document.getElementById('status-custom-input');
const statusNoteInputEl = document.getElementById('status-note-input');
const saveStatusBtn = document.getElementById('save-status-btn');
const privacyToggleEl = document.getElementById('privacy-toggle');
const eyeOpenEl = document.getElementById('eye-open');
const eyeClosedEl = document.getElementById('eye-closed');

const KNOWN_PRESETS = new Set(['Sibuk', 'Tugas Belajar', 'Cuti', 'Rapat']);
const CUSTOM_TOGGLE_DEFAULT_LABEL = 'Lainnya…';

if (!configOk) {
  boardEl.innerHTML = '<p class="text-muted dark:text-muteddark text-center py-8 col-span-full">Set SUPABASE_URL and SUPABASE_ANON_KEY in web/config.js to load the board.</p>';
  throw new Error('config.js still has placeholder Supabase credentials');
}

const NOTICE_CLASSES = {
  error: 'text-sm px-4 py-3 rounded bg-absentsoft dark:bg-absentsoftdark text-absentc dark:text-absentcdark border border-absentc/20 dark:border-absentcdark/20 mb-4',
  info: 'text-sm px-4 py-3 rounded bg-presentsoft dark:bg-presentsoftdark text-present dark:text-presentdark border border-present/20 dark:border-presentdark/20 mb-4',
};

function showNotice(message, kind = 'error') {
  noticeEl.innerHTML = `<p class="${NOTICE_CLASSES[kind]}">${escapeHtml(message)}</p>`;
}

function clearNotice() {
  noticeEl.innerHTML = '';
}

/** @type {Map<string, {user_id: string, full_name: string, status: string, last_seen_at: string|null, since: string|null, photo_url: string|null, note: string|null}>} */
const rows = new Map();

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function relativeTime(iso) {
  if (!iso) return 'belum terdeteksi';
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 5) return 'baru saja';
  if (s < 60) return `${s}d lalu`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}j lalu`;
  return `${Math.floor(h / 24)} hari lalu`;
}

function timeOfDay(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function initials(name) {
  const letters = name.replace(/,.*/, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '');
  return letters.join('').toUpperCase();
}

// Status is open-ended (a manual status can be any short text a lecturer
// chooses), not a strict enum. present/absent/private get their own
// dedicated tab treatment; the 4 known presets each get a distinct color;
// anything else (custom-typed text) falls back to a generic brass tab.
const PRESET_TAB_CLASSES = {
  sibuk: 'bg-sibuk dark:bg-sibukdark text-white dark:text-paperdark',
  'tugas belajar': 'bg-tugasbelajar dark:bg-tugasbelajardark text-white dark:text-paperdark',
  cuti: 'bg-cuti dark:bg-cutidark text-white dark:text-paperdark',
  rapat: 'bg-rapat dark:bg-rapatdark text-white dark:text-paperdark',
};

function statusTab(status) {
  if (status === 'present') return { label: 'MASUK', classes: 'bg-present dark:bg-presentdark text-white dark:text-paperdark' };
  if (status === 'absent') return { label: 'KELUAR', classes: 'bg-absentc dark:bg-absentcdark text-white dark:text-paperdark' };
  if (status === 'private') return { label: 'DISEMBUNYIKAN', classes: 'bg-muted dark:bg-muteddark text-white dark:text-paperdark' };
  const preset = PRESET_TAB_CLASSES[status.toLowerCase()];
  return { label: status.toUpperCase(), classes: preset || 'bg-brass dark:bg-brassdark text-white dark:text-paperdark' };
}

function seenLine(r) {
  if (r.status === 'present') return `Sejak ${timeOfDay(r.since)}`;
  if (r.status === 'absent') return relativeTime(r.last_seen_at);
  if (r.status === 'private') return '';
  // Manual status: prefer the note; fall back to when it was set.
  return r.note || (r.since ? `Sejak ${timeOfDay(r.since)}` : '');
}

function plateCard(r) {
  const tab = statusTab(r.status);
  const photo = r.photo_url
    ? `<img class="w-13 h-13 rounded object-cover border border-line dark:border-linedark shrink-0" style="width:52px;height:52px" src="${escapeHtml(r.photo_url)}" alt="${escapeHtml(r.full_name)}" loading="lazy" />`
    : `<div class="w-13 h-13 rounded border border-line dark:border-linedark shrink-0 flex items-center justify-center bg-surface2 dark:bg-surfacedark2 font-plate text-sm text-muted dark:text-muteddark" style="width:52px;height:52px">${escapeHtml(initials(r.full_name))}</div>`;

  // A note is only ever present alongside a manual status. When set, it's the
  // most useful thing on the card, so lead with it and demote the name to a
  // small subline instead of the usual name-on-top layout.
  const seenText = seenLine(r);
  const textBlock = r.note
    ? `<p class="font-plate text-base leading-snug break-words">${escapeHtml(r.note)}</p>
       <p class="text-xs text-muted dark:text-muteddark break-words">${escapeHtml(r.full_name)}</p>`
    : `<h3 class="font-plate font-semibold text-base leading-snug break-words">${escapeHtml(r.full_name)}</h3>
       ${seenText ? `<p class="text-xs text-muted dark:text-muteddark [font-variant-numeric:tabular-nums] break-words">${escapeHtml(seenText)}</p>` : ''}`;

  return `
    <article class="relative flex items-center gap-3.5 px-4 py-3.5 bg-surface dark:bg-surfacedark border border-line dark:border-linedark rounded shadow-sm overflow-hidden">
      ${photo}
      <div class="min-w-0 flex-1">
        ${textBlock}
      </div>
      <span class="shrink-0 self-stretch w-32 flex items-center justify-center text-center leading-tight break-words pl-4 pr-2 -my-3.5 -mr-4 text-[0.68rem] font-bold tracking-wider ${tab.classes}"
        style="clip-path:polygon(22% 0, 100% 0, 100% 100%, 0% 100%)"
      >${escapeHtml(tab.label)}</span>
    </article>`;
}

function render() {
  const list = Array.from(rows.values()).sort((a, b) => a.full_name.localeCompare(b.full_name));

  boardEl.innerHTML = list.length
    ? list.map(plateCard).join('')
    : '<p class="text-muted dark:text-muteddark text-center py-8 col-span-full">Belum ada data dosen.</p>';

  updatedEl.textContent = `Diperbarui ${new Date().toLocaleTimeString('id-ID')}`;
}

async function loadInitial() {
  const { data, error } = await supabase.from('presence_board').select('*');
  if (error) {
    boardEl.innerHTML = '<p class="text-muted dark:text-muteddark text-center py-8 col-span-full">Gagal memuat data kehadiran.</p>';
    console.error(error);
    return;
  }
  rows.clear();
  for (const row of data) rows.set(row.user_id, row);
  render();
}

async function refreshUser(userId) {
  const { data, error } = await supabase
    .from('presence_board')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error(error);
    return;
  }
  if (data) rows.set(userId, data);
  render();
}

function subscribeRealtime() {
  supabase
    .channel('presence-changes')
    .on('postgres_changes', { event: '*', schema: DB_SCHEMA, table: 'presence' }, (payload) => {
      const userId = payload.new?.user_id ?? payload.old?.user_id;
      if (userId) refreshUser(userId);
    })
    .on('postgres_changes', { event: '*', schema: DB_SCHEMA, table: 'users' }, (payload) => {
      const userId = payload.new?.id ?? payload.old?.id;
      if (userId) refreshUser(userId);
    })
    .subscribe();
}

// --- Sign-in + self-service manual status/note + privacy mode ---------

async function loadStatus() {
  const { data, error } = await supabase
    .from('users')
    .select('manual_status, manual_note, privacy_mode')
    .maybeSingle();
  if (error) {
    console.error(error);
    return;
  }
  if (!data) return;

  setActiveStatus(data.manual_status || '');
  statusNoteInputEl.value = data.manual_note || '';

  const privacyOn = Boolean(data.privacy_mode);
  privacyToggleEl.setAttribute('aria-pressed', String(privacyOn));
  eyeOpenEl.hidden = privacyOn;
  eyeClosedEl.hidden = !privacyOn;
}

// Reflects `status` (empty string = Otomatis) in the toggle group's visual
// active state, including self-labeling the "Lainnya..." pill with the
// actual custom text when that's what's active. This is the single place
// that reflects a selection -- whether it came from the server (loadStatus,
// on load / after a save) or a local click (nothing sent to the server
// until Simpan is pressed).
function setActiveStatus(status) {
  const isKnown = status === '' || KNOWN_PRESETS.has(status);
  statusCustomToggleBtn.textContent = isKnown ? CUSTOM_TOGGLE_DEFAULT_LABEL : status;

  for (const btn of statusToggleBtns) {
    const isActive = isKnown ? btn.dataset.status === status : btn === statusCustomToggleBtn;
    btn.classList.toggle('bg-brass', isActive);
    btn.classList.toggle('dark:bg-brassdark', isActive);
    btn.classList.toggle('text-white', isActive);
    btn.classList.toggle('dark:text-paperdark', isActive);
    btn.classList.toggle('border-brass', isActive);
    btn.classList.toggle('dark:border-brassdark', isActive);
    // A :hover class rule outranks a plain bg-brass rule by specificity, so
    // without this the button flashes back to its pale hover fill while the
    // cursor still sits on it right after being clicked. Drop the neutral
    // hover classes while active so there's no hover rule left to win.
    btn.classList.toggle('hover:bg-surface2', !isActive);
    btn.classList.toggle('dark:hover:bg-surfacedark2', !isActive);
  }

  statusCustomInputEl.hidden = true;
  statusCustomInputEl.value = isKnown ? '' : status;
  statusNoteInputEl.disabled = status === '';
}

async function saveStatus(status, note) {
  const { error } = await supabase.rpc('set_manual_status', {
    p_status: status.trim() || null,
    p_note: note.trim() || null,
  });
  if (error) {
    showNotice(error.message);
    return;
  }
  showNotice('Status berhasil diperbarui.', 'info');
  await loadStatus();
}

// Reads whatever's currently selected in the toggle group -- purely local
// state, since clicking a pill no longer saves by itself (see below).
function getActiveStatus() {
  const activeBtn = statusToggleBtns.find((btn) => btn.classList.contains('bg-brass'));
  if (!activeBtn) return '';
  // setActiveStatus() already keeps this in sync with the real custom text
  // whenever the custom pill is the active one, so no need to also read the
  // (hidden) input's value here.
  return activeBtn === statusCustomToggleBtn ? activeBtn.textContent : activeBtn.dataset.status;
}

async function togglePrivacy() {
  const enabled = privacyToggleEl.getAttribute('aria-pressed') !== 'true';
  const { error } = await supabase.rpc('set_privacy_mode', { p_enabled: enabled });
  if (error) {
    showNotice(error.message);
    return;
  }
  clearNotice();
  privacyToggleEl.setAttribute('aria-pressed', String(enabled));
  eyeOpenEl.hidden = enabled;
  eyeClosedEl.hidden = !enabled;
}

for (const btn of statusToggleBtns) {
  if (btn === statusCustomToggleBtn) continue;
  btn.addEventListener('click', () => setActiveStatus(btn.dataset.status));
}

statusCustomToggleBtn.addEventListener('click', () => {
  statusCustomInputEl.hidden = false;
  statusCustomInputEl.focus();
});

statusCustomInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    statusCustomInputEl.value = '';
    statusCustomInputEl.hidden = true;
    return;
  }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const value = statusCustomInputEl.value.trim();
  if (value) setActiveStatus(value);
});

statusCustomInputEl.addEventListener('blur', () => {
  if (!statusCustomInputEl.value.trim()) statusCustomInputEl.hidden = true;
});

saveStatusBtn.addEventListener('click', () => saveStatus(getActiveStatus(), statusNoteInputEl.value));

privacyToggleEl.addEventListener('click', togglePrivacy);

async function signOut() {
  await supabase.auth.signOut();
  renderAuth(null);
}

async function renderAuth(session) {
  const email = await checkDomainOrSignOut(session);

  if (!session) {
    signedOutCardEl.hidden = false;
    statusWrapEl.hidden = true;
    return;
  }

  if (!email) {
    showNotice(`Hanya akun ${REQUIRED_DOMAIN} yang dapat memperbarui status. Anda masuk sebagai ${session.user.email}.`);
    signedOutCardEl.hidden = false;
    statusWrapEl.hidden = true;
    return;
  }

  clearNotice();
  signedOutCardEl.hidden = true;
  statusWrapEl.hidden = false;
  userEmailEl.textContent = email;
  await loadStatus();
}

signInLinkEl.addEventListener('click', () => signInWithGoogle());
signOutBtn.addEventListener('click', signOut);

supabase.auth.onAuthStateChange((_event, session) => renderAuth(session));
supabase.auth.getSession().then(({ data }) => renderAuth(data.session));

// ------------------------------------------------------------------------

setInterval(render, 15000); // keep relative timestamps fresh even with no new events

loadInitial().then(subscribeRealtime);
