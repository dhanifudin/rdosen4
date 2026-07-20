import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const noticeEl = document.getElementById('notice');
const signedOutEl = document.getElementById('signed-out');
const signedInEl = document.getElementById('signed-in');
const userEmailEl = document.getElementById('user-email');
const signInBtn = document.getElementById('sign-in');
const signOutBtn = document.getElementById('sign-out');

const detectWrapEl = document.getElementById('detect-wrap');
const detectIdleEl = document.getElementById('detect-idle');
const detectActiveEl = document.getElementById('detect-active');
const detectLabelInputEl = document.getElementById('detect-label-input');
const detectStartBtn = document.getElementById('detect-start');
const detectStep2El = document.getElementById('detect-step2');
const detectConfirmOffBtn = document.getElementById('detect-confirm-off');
const detectWaitingEl = document.getElementById('detect-waiting');
const detectCountdownEl = document.getElementById('detect-countdown');
const detectCancelBtn = document.getElementById('detect-cancel');

const manualFallbackEl = document.getElementById('manual-fallback');
const formEl = document.getElementById('register-form');
const macInputEl = document.getElementById('mac-input');
const labelInputEl = document.getElementById('label-input');

const devicesWrapEl = document.getElementById('devices-wrap');
const devicesListEl = document.getElementById('devices-list');

const statusWrapEl = document.getElementById('status-wrap');
const statusCurrentEl = document.getElementById('status-current');
const statusCurrentTextEl = document.getElementById('status-current-text');
const statusFormEl = document.getElementById('status-form');
const statusInputEl = document.getElementById('status-input');
const statusNoteInputEl = document.getElementById('status-note-input');
const statusClearBtn = document.getElementById('status-clear');
const privacyToggleEl = document.getElementById('privacy-toggle');

const NOTICE_CLASSES = {
  error: 'text-sm px-4 py-3 rounded bg-absentsoft dark:bg-absentsoftdark text-absentc dark:text-absentcdark border border-absentc/20 dark:border-absentcdark/20 mb-4',
  info: 'text-sm px-4 py-3 rounded bg-presentsoft dark:bg-presentsoftdark text-present dark:text-presentdark border border-present/20 dark:border-presentdark/20 mb-4',
};

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-ANON')) {
  noticeEl.innerHTML = `<p class="${NOTICE_CLASSES.error}">Set SUPABASE_URL and SUPABASE_ANON_KEY in web/config.js to enable sign-in.</p>`;
  throw new Error('config.js still has placeholder Supabase credentials');
}

// All attendance objects live in the `dosen4` Postgres schema — see
// ../supabase/schema.sql.
const DB_SCHEMA = 'dosen4';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { db: { schema: DB_SCHEMA } });

const REQUIRED_DOMAIN = '@polinema.ac.id';
const MAC_RE = /^([0-9a-fA-F]{2}[:.\-]?){5}[0-9a-fA-F]{2}$/;
const DETECT_POLL_MS = 2000;

let detectPollTimer = null;
let detectCountdownTimer = null;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function showNotice(message, kind = 'error') {
  noticeEl.innerHTML = `<p class="${NOTICE_CLASSES[kind]}">${escapeHtml(message)}</p>`;
}

function clearNotice() {
  noticeEl.innerHTML = '';
}

async function signIn() {
  const redirectTo = window.location.origin + window.location.pathname;
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, queryParams: { hd: 'polinema.ac.id' } },
  });
}

async function signOut() {
  stopDetection();
  await supabase.auth.signOut();
  render(null);
}

async function loadDevices() {
  const { data, error } = await supabase
    .from('devices')
    .select('id, mac_address, label, created_at')
    .order('created_at', { ascending: true });
  if (error) {
    console.error(error);
    return;
  }
  devicesListEl.innerHTML = data.length
    ? data.map((d) => `
        <div class="flex items-center gap-3 px-3.5 py-2.5 bg-surface dark:bg-surfacedark border border-line dark:border-linedark rounded text-sm" data-id="${d.id}">
          <span class="font-mono text-xs text-muted dark:text-muteddark">${escapeHtml(d.mac_address)}</span>
          <span class="flex-1 min-w-0 truncate">${escapeHtml(d.label || '')}</span>
          <button class="remove-btn shrink-0 px-2.5 py-1 rounded border border-line dark:border-linedark text-xs font-semibold text-absentc dark:text-absentcdark hover:bg-absentsoft dark:hover:bg-absentsoftdark" data-id="${d.id}">Hapus</button>
        </div>
      `).join('')
    : '<p class="text-sm text-muted dark:text-muteddark">Belum ada perangkat terdaftar.</p>';

  devicesListEl.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => removeDevice(btn.dataset.id));
  });
}

async function removeDevice(deviceId) {
  const { error } = await supabase.rpc('remove_device', { device_id: deviceId });
  if (error) {
    showNotice(error.message);
    return;
  }
  clearNotice();
  await loadDevices();
}

async function registerDevice(mac, label) {
  if (!MAC_RE.test(mac.trim())) {
    showNotice('Format alamat MAC tidak valid.');
    return;
  }
  const { error } = await supabase.rpc('register_device', { mac: mac.trim(), label: label.trim() || null });
  if (error) {
    showNotice(error.message);
    return;
  }
  clearNotice();
  macInputEl.value = '';
  labelInputEl.value = '';
  await loadDevices();
}

// --- Manual status/note + privacy mode --------------------------------

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

  if (data.manual_status) {
    statusCurrentEl.hidden = false;
    statusCurrentTextEl.textContent = data.manual_note
      ? `${data.manual_status} — ${data.manual_note}`
      : data.manual_status;
    statusInputEl.value = data.manual_status;
    statusNoteInputEl.value = data.manual_note || '';
  } else {
    statusCurrentEl.hidden = true;
    statusInputEl.value = '';
    statusNoteInputEl.value = '';
  }

  privacyToggleEl.checked = Boolean(data.privacy_mode);
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

async function clearStatus() {
  await saveStatus('', '');
}

async function togglePrivacy(enabled) {
  const { error } = await supabase.rpc('set_privacy_mode', { p_enabled: enabled });
  if (error) {
    showNotice(error.message);
    privacyToggleEl.checked = !enabled; // revert the checkbox on failure
    return;
  }
  clearNotice();
}

document.querySelectorAll('.status-preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    statusInputEl.value = btn.dataset.status;
    statusInputEl.focus();
  });
});

statusFormEl.addEventListener('submit', (e) => {
  e.preventDefault();
  saveStatus(statusInputEl.value, statusNoteInputEl.value);
});

statusClearBtn.addEventListener('click', clearStatus);
privacyToggleEl.addEventListener('change', () => togglePrivacy(privacyToggleEl.checked));

// --- Auto-detect via Wi-Fi reconnect ---------------------------------

function resetDetectUI() {
  stopDetection();
  detectIdleEl.hidden = false;
  detectActiveEl.hidden = true;
  detectStep2El.hidden = true;
  detectWaitingEl.hidden = true;
}

function showDetectStep2() {
  detectIdleEl.hidden = true;
  detectActiveEl.hidden = false;
  detectStep2El.hidden = false;
  detectWaitingEl.hidden = true;
}

function showDetectWaiting() {
  detectStep2El.hidden = true;
  detectWaitingEl.hidden = false;
}

function stopDetection() {
  if (detectPollTimer) { clearInterval(detectPollTimer); detectPollTimer = null; }
  if (detectCountdownTimer) { clearInterval(detectCountdownTimer); detectCountdownTimer = null; }
}

async function startDetection() {
  const label = detectLabelInputEl.value.trim() || null;
  const { data, error } = await supabase.rpc('start_detection_window', { p_label: label });
  if (error) {
    showNotice(error.message);
    resetDetectUI();
    return;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const windowId = row.id;
  const expiresAt = new Date(row.expires_at).getTime();

  clearNotice();
  showDetectWaiting();

  const updateCountdown = () => {
    const secs = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    detectCountdownEl.textContent = `sisa ${secs} detik`;
    if (secs <= 0) {
      stopDetection();
      showNotice('Tidak ada perangkat baru terdeteksi — pastikan Wi-Fi dimatikan sebelum memulai, lalu coba lagi.');
      resetDetectUI();
    }
  };
  updateCountdown();
  detectCountdownTimer = setInterval(updateCountdown, 1000);

  detectPollTimer = setInterval(async () => {
    const { data: win, error: pollErr } = await supabase
      .from('detection_windows')
      .select('status')
      .eq('id', windowId)
      .maybeSingle();
    if (pollErr) {
      console.error(pollErr);
      return;
    }
    if (!win || win.status === 'open') return;

    stopDetection();
    if (win.status === 'resolved') {
      showNotice('Perangkat berhasil didaftarkan!', 'info');
      resetDetectUI();
      await loadDevices();
    } else if (win.status === 'ambiguous') {
      showNotice('Ada perangkat lain yang terhubung pada saat bersamaan — silakan coba lagi.');
      resetDetectUI();
    } else {
      showNotice('Tidak ada perangkat baru terdeteksi — pastikan Wi-Fi dimatikan sebelum memulai, lalu coba lagi.');
      resetDetectUI();
    }
  }, DETECT_POLL_MS);
}

detectStartBtn.addEventListener('click', showDetectStep2);
detectConfirmOffBtn.addEventListener('click', startDetection);
detectCancelBtn.addEventListener('click', () => {
  clearNotice();
  resetDetectUI();
});

// -----------------------------------------------------------------------

async function render(session) {
  if (!session) {
    signedOutEl.hidden = false;
    signedInEl.hidden = true;
    statusWrapEl.hidden = true;
    detectWrapEl.hidden = true;
    manualFallbackEl.hidden = true;
    devicesWrapEl.hidden = true;
    return;
  }

  const email = session.user.email || '';
  if (!email.toLowerCase().endsWith(REQUIRED_DOMAIN)) {
    showNotice(`Hanya akun ${REQUIRED_DOMAIN} yang dapat mendaftarkan perangkat. Anda masuk sebagai ${email}.`);
    await supabase.auth.signOut();
    signedOutEl.hidden = false;
    signedInEl.hidden = true;
    statusWrapEl.hidden = true;
    detectWrapEl.hidden = true;
    manualFallbackEl.hidden = true;
    devicesWrapEl.hidden = true;
    return;
  }

  clearNotice();
  signedOutEl.hidden = true;
  signedInEl.hidden = false;
  statusWrapEl.hidden = false;
  detectWrapEl.hidden = false;
  manualFallbackEl.hidden = false;
  devicesWrapEl.hidden = false;
  userEmailEl.textContent = email;
  resetDetectUI();
  await loadStatus();
  await loadDevices();
}

signInBtn.addEventListener('click', signIn);
signOutBtn.addEventListener('click', signOut);
formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  registerDevice(macInputEl.value, labelInputEl.value);
});

supabase.auth.onAuthStateChange((_event, session) => render(session));
supabase.auth.getSession().then(({ data }) => render(data.session));
