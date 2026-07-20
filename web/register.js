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

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-ANON')) {
  noticeEl.innerHTML = '<p class="notice error">Set SUPABASE_URL and SUPABASE_ANON_KEY in web/config.js to enable sign-in.</p>';
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
  noticeEl.innerHTML = `<p class="notice ${kind}">${escapeHtml(message)}</p>`;
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
        <div class="device-row" data-id="${d.id}">
          <span class="mac">${escapeHtml(d.mac_address)}</span>
          <span class="label">${escapeHtml(d.label || '')}</span>
          <button class="btn danger remove-btn" data-id="${d.id}">Remove</button>
        </div>
      `).join('')
    : '<p class="empty">No devices registered yet.</p>';

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
    showNotice('That doesn\'t look like a valid MAC address.');
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
    detectCountdownEl.textContent = `${secs}s remaining`;
    if (secs <= 0) {
      stopDetection();
      showNotice('No new device detected — make sure you turned Wi-Fi off before starting, then try again.');
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
      showNotice('Device registered!', 'info');
      resetDetectUI();
      await loadDevices();
    } else if (win.status === 'ambiguous') {
      showNotice('Another device joined the network at the same moment — please try again.');
      resetDetectUI();
    } else {
      showNotice('No new device detected — make sure you turned Wi-Fi off before starting, then try again.');
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
    detectWrapEl.hidden = true;
    manualFallbackEl.hidden = true;
    devicesWrapEl.hidden = true;
    return;
  }

  const email = session.user.email || '';
  if (!email.toLowerCase().endsWith(REQUIRED_DOMAIN)) {
    showNotice(`Only ${REQUIRED_DOMAIN} accounts can register a device. Signed in as ${email}.`);
    await supabase.auth.signOut();
    signedOutEl.hidden = false;
    signedInEl.hidden = true;
    detectWrapEl.hidden = true;
    manualFallbackEl.hidden = true;
    devicesWrapEl.hidden = true;
    return;
  }

  clearNotice();
  signedOutEl.hidden = true;
  signedInEl.hidden = false;
  detectWrapEl.hidden = false;
  manualFallbackEl.hidden = false;
  devicesWrapEl.hidden = false;
  userEmailEl.textContent = email;
  resetDetectUI();
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
