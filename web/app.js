import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const boardEl = document.getElementById('board');
const updatedEl = document.getElementById('last-updated');
const searchEl = document.getElementById('search');

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-ANON')) {
  boardEl.innerHTML = '<p class="empty">Set SUPABASE_URL and SUPABASE_ANON_KEY in web/config.js to load the board.</p>';
  throw new Error('config.js still has placeholder Supabase credentials');
}

// All attendance objects live in the `dosen4` Postgres schema (not
// `public`) — see ../supabase/schema.sql. It must be added to Supabase's
// "Exposed schemas" (Project Settings -> API) or every call below 404s.
const DB_SCHEMA = 'dosen4';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { db: { schema: DB_SCHEMA } });

/** @type {Map<string, {user_id: string, full_name: string, status: string, last_seen_at: string|null, since: string|null}>} */
const rows = new Map();

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function relativeTime(iso) {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function render() {
  const filter = searchEl.value.trim().toLowerCase();
  const list = Array.from(rows.values())
    .filter((r) => !filter || r.full_name.toLowerCase().includes(filter))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  boardEl.innerHTML = list.length
    ? list.map((r) => `
        <div class="row">
          <span class="name">${escapeHtml(r.full_name)}</span>
          <span class="badge ${r.status}">${r.status}</span>
          <span class="seen">${relativeTime(r.last_seen_at)}</span>
        </div>
      `).join('')
    : '<p class="empty">No matching people.</p>';

  updatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

async function loadInitial() {
  const { data, error } = await supabase.from('presence_board').select('*');
  if (error) {
    boardEl.innerHTML = '<p class="empty">Failed to load attendance data.</p>';
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
    .subscribe();
}

searchEl.addEventListener('input', render);
setInterval(render, 15000); // keep relative timestamps fresh even with no new events

loadInitial().then(subscribeRealtime);
