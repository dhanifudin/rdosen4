import { supabase, configOk, DB_SCHEMA, REQUIRED_DOMAIN, signInWithGoogle, checkDomainOrSignOut } from './supabase-client.js';

const layoutGridEl = document.getElementById('layout-grid');
const boardWrapEl = document.getElementById('board-wrap');
const boardEl = document.getElementById('board');
const updatedEl = document.getElementById('last-updated');

const noticeEl = document.getElementById('notice');
const signInLinkEl = document.getElementById('sign-in-link');
const signedInInfoEl = document.getElementById('signed-in-info');
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

// The sidebar's grid classes are toggled in JS, not baked into the static
// HTML -- the two-column split should only reserve width for the sidebar
// while there's an actual status panel to show, not for every signed-out
// visitor (display:none on a hidden grid item does NOT reclaim its
// column's width, so this can't be done with CSS/hidden alone).
const SIDEBAR_GRID_CLASSES = ['xl:grid', 'xl:grid-cols-[1fr_280px]', 'xl:gap-8', 'xl:items-start'];
const SIDEBAR_ASIDE_CLASSES = ['xl:order-2', 'xl:sticky', 'xl:top-10', 'xl:mb-0'];
const BOARD_ORDER_CLASSES = ['xl:order-1'];

function setSidebarLayout(active) {
  for (const c of SIDEBAR_GRID_CLASSES) layoutGridEl.classList.toggle(c, active);
  for (const c of SIDEBAR_ASIDE_CLASSES) statusWrapEl.classList.toggle(c, active);
  for (const c of BOARD_ORDER_CLASSES) boardWrapEl.classList.toggle(c, active);
}

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
    ? `<img class="rounded object-cover border border-line dark:border-linedark shrink-0" style="width:72px;height:72px" src="${escapeHtml(r.photo_url)}" alt="${escapeHtml(r.full_name)}" loading="lazy" />`
    : `<div class="rounded border border-line dark:border-linedark shrink-0 flex items-center justify-center bg-surface2 dark:bg-surfacedark2 font-plate text-sm text-muted dark:text-muteddark" style="width:72px;height:72px">${escapeHtml(initials(r.full_name))}</div>`;

  // The name lives on its own full-width row below the photo, so the slot
  // beside the photo is reserved exclusively for the note/info line: the
  // manual note if one is set, else the auto-tracking timestamp, else empty
  // (e.g. private with no note) -- never both, no swapping needed.
  const seenText = seenLine(r);
  const infoLine = r.note
    ? `<p class="font-plate text-sm leading-snug break-words">${escapeHtml(r.note)}</p>`
    : (seenText ? `<p class="text-xs text-muted dark:text-muteddark [font-variant-numeric:tabular-nums] break-words">${escapeHtml(seenText)}</p>` : '');
  // Only reserve the flex-1 middle slot when there's something to put in it --
  // an empty flex-1 div still claims its share of the row's width via
  // flex-grow, which is exactly what read as a dead gap between the photo
  // and the badge (e.g. "private" with no note). justify-between pulls the
  // badge flush against the photo's side when there's nothing between them.
  const infoSlot = infoLine ? `<div class="min-w-0 flex-1">${infoLine}</div>` : '';

  return `
    <article class="relative flex flex-col gap-2 px-4 py-3 bg-surface dark:bg-surfacedark border border-line dark:border-linedark rounded shadow-sm overflow-hidden">
      <div class="flex items-center justify-between gap-3">
        ${photo}
        ${infoSlot}
        <span class="shrink-0 self-stretch w-32 flex items-center justify-center text-center leading-tight break-words pl-4 pr-2 -mt-3 -mr-4 text-[0.68rem] font-bold tracking-wider ${tab.classes}"
          style="clip-path:polygon(22% 0, 100% 0, 100% 100%, 0% 100%)"
        >${escapeHtml(tab.label)}</span>
      </div>
      <h3 class="font-plate font-semibold text-base leading-snug break-words">${escapeHtml(r.full_name)}</h3>
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
  const value = statusCustomInputEl.value.trim();
  if (value) {
    // Commit on any way of leaving the field, not just Enter -- otherwise
    // "type text, then click Simpan" silently re-saves whatever was
    // previously active instead of the text just typed.
    setActiveStatus(value);
  } else {
    statusCustomInputEl.hidden = true;
  }
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
    signInLinkEl.hidden = false;
    signedInInfoEl.hidden = true;
    statusWrapEl.hidden = true;
    setSidebarLayout(false);
    return;
  }

  if (!email) {
    showNotice(`Hanya akun ${REQUIRED_DOMAIN} yang dapat memperbarui status. Anda masuk sebagai ${session.user.email}.`);
    signInLinkEl.hidden = false;
    signedInInfoEl.hidden = true;
    statusWrapEl.hidden = true;
    setSidebarLayout(false);
    return;
  }

  clearNotice();
  signInLinkEl.hidden = true;
  signedInInfoEl.hidden = false;
  statusWrapEl.hidden = false;
  setSidebarLayout(true);
  userEmailEl.textContent = email;
  await loadStatus();
}

signInLinkEl.addEventListener('click', (e) => {
  e.preventDefault();
  signInWithGoogle();
});
signOutBtn.addEventListener('click', signOut);

supabase.auth.onAuthStateChange((_event, session) => renderAuth(session));
supabase.auth.getSession().then(({ data }) => renderAuth(data.session));

// ------------------------------------------------------------------------

setInterval(render, 15000); // keep relative timestamps fresh even with no new events

loadInitial().then(subscribeRealtime);
