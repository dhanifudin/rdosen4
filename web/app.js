import { supabase, configOk, DB_SCHEMA, REQUIRED_DOMAIN, signInWithGoogle, checkDomainOrSignOut } from './supabase-client.js';

const boardEl = document.getElementById('board');
const updatedEl = document.getElementById('last-updated');
const searchEl = document.getElementById('search');

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
  sibuk: 'bg-sibuksoft dark:bg-sibuksoftdark text-sibuk dark:text-sibukdark',
  'tugas belajar': 'bg-tugasbelajarsoft dark:bg-tugasbelajarsoftdark text-tugasbelajar dark:text-tugasbelajardark',
  cuti: 'bg-cutisoft dark:bg-cutisoftdark text-cuti dark:text-cutidark',
  rapat: 'bg-rapatsoft dark:bg-rapatsoftdark text-rapat dark:text-rapatdark',
};

function statusTab(status) {
  if (status === 'present') return { label: 'MASUK', classes: 'bg-presentsoft dark:bg-presentsoftdark text-present dark:text-presentdark' };
  if (status === 'absent') return { label: 'KELUAR', classes: 'bg-absentsoft dark:bg-absentsoftdark text-absentc dark:text-absentcdark' };
  if (status === 'private') return { label: 'PRIBADI', classes: 'bg-surface2 dark:bg-surfacedark2 text-muted dark:text-muteddark' };
  const preset = PRESET_TAB_CLASSES[status.toLowerCase()];
  return { label: status.toUpperCase(), classes: preset || 'bg-brasssoft dark:bg-brasssoftdark text-brass dark:text-brassdark' };
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
  const seenText = seenLine(r);
  const photo = r.photo_url
    ? `<img class="w-13 h-13 rounded object-cover border border-line dark:border-linedark shrink-0" style="width:52px;height:52px" src="${escapeHtml(r.photo_url)}" alt="${escapeHtml(r.full_name)}" loading="lazy" />`
    : `<div class="w-13 h-13 rounded border border-line dark:border-linedark shrink-0 flex items-center justify-center bg-surface2 dark:bg-surfacedark2 font-plate text-sm text-muted dark:text-muteddark" style="width:52px;height:52px">${escapeHtml(initials(r.full_name))}</div>`;

  return `
    <article class="relative flex items-center gap-3.5 px-4 py-3.5 bg-surface dark:bg-surfacedark border border-line dark:border-linedark rounded shadow-sm overflow-hidden">
      ${photo}
      <div class="min-w-0 flex-1">
        <h3 class="font-plate font-semibold text-base leading-snug break-words">${escapeHtml(r.full_name)}</h3>
        ${seenText ? `<p class="text-xs text-muted dark:text-muteddark [font-variant-numeric:tabular-nums] break-words">${escapeHtml(seenText)}</p>` : ''}
      </div>
      <span class="shrink-0 self-stretch flex items-center px-2.5 -my-3.5 -mr-4 text-[0.68rem] font-bold tracking-wider ${tab.classes}"
        style="clip-path:polygon(28% 0, 100% 0, 100% 100%, 0% 100%)"
      >${escapeHtml(tab.label)}</span>
    </article>`;
}

function render() {
  const filter = searchEl.value.trim().toLowerCase();
  const all = Array.from(rows.values());
  const list = all
    .filter((r) => !filter || r.full_name.toLowerCase().includes(filter))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  boardEl.innerHTML = list.length
    ? list.map(plateCard).join('')
    : '<p class="text-muted dark:text-muteddark text-center py-8 col-span-full">Tidak ada dosen yang cocok.</p>';

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
  statusNoteInputEl.disabled = !data.manual_status;

  const privacyOn = Boolean(data.privacy_mode);
  privacyToggleEl.setAttribute('aria-pressed', String(privacyOn));
  eyeOpenEl.hidden = privacyOn;
  eyeClosedEl.hidden = !privacyOn;
}

// Reflects `status` (empty string = Otomatis) in the toggle group's visual
// active state, including self-labeling the "Lainnya..." pill with the
// actual custom text when that's what's active.
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
  }

  statusCustomInputEl.hidden = true;
  statusCustomInputEl.value = isKnown ? '' : status;
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
  clearNotice();
  await loadStatus();
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
  btn.addEventListener('click', () => saveStatus(btn.dataset.status, statusNoteInputEl.value));
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
  if (value) saveStatus(value, statusNoteInputEl.value);
});

statusCustomInputEl.addEventListener('blur', () => {
  if (!statusCustomInputEl.value.trim()) statusCustomInputEl.hidden = true;
});

statusNoteInputEl.addEventListener('blur', () => {
  const activeBtn = statusToggleBtns.find((btn) => btn.classList.contains('bg-brass'));
  const activeStatus = activeBtn === statusCustomToggleBtn
    ? statusCustomInputEl.value.trim() || activeBtn.textContent
    : activeBtn?.dataset.status;
  if (activeStatus) saveStatus(activeStatus, statusNoteInputEl.value);
});

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
    return;
  }

  if (!email) {
    showNotice(`Hanya akun ${REQUIRED_DOMAIN} yang dapat memperbarui status. Anda masuk sebagai ${session.user.email}.`);
    signInLinkEl.hidden = false;
    signedInInfoEl.hidden = true;
    statusWrapEl.hidden = true;
    return;
  }

  clearNotice();
  signInLinkEl.hidden = true;
  signedInInfoEl.hidden = false;
  statusWrapEl.hidden = false;
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

searchEl.addEventListener('input', render);
setInterval(render, 15000); // keep relative timestamps fresh even with no new events

loadInitial().then(subscribeRealtime);
