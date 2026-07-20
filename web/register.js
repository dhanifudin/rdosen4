import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const noticeEl = document.getElementById('notice');
const signedOutEl = document.getElementById('signed-out');
const signedInEl = document.getElementById('signed-in');
const userEmailEl = document.getElementById('user-email');
const formWrapEl = document.getElementById('register-form-wrap');
const formEl = document.getElementById('register-form');
const macInputEl = document.getElementById('mac-input');
const labelInputEl = document.getElementById('label-input');
const devicesWrapEl = document.getElementById('devices-wrap');
const devicesListEl = document.getElementById('devices-list');
const signInBtn = document.getElementById('sign-in');
const signOutBtn = document.getElementById('sign-out');

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

async function render(session) {
  if (!session) {
    signedOutEl.hidden = false;
    signedInEl.hidden = true;
    formWrapEl.hidden = true;
    devicesWrapEl.hidden = true;
    return;
  }

  const email = session.user.email || '';
  if (!email.toLowerCase().endsWith(REQUIRED_DOMAIN)) {
    showNotice(`Only ${REQUIRED_DOMAIN} accounts can register a device. Signed in as ${email}.`);
    await supabase.auth.signOut();
    signedOutEl.hidden = false;
    signedInEl.hidden = true;
    formWrapEl.hidden = true;
    devicesWrapEl.hidden = true;
    return;
  }

  clearNotice();
  signedOutEl.hidden = true;
  signedInEl.hidden = false;
  formWrapEl.hidden = false;
  devicesWrapEl.hidden = false;
  userEmailEl.textContent = email;
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
