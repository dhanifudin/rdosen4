import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const boardEl = document.getElementById('board');
const updatedEl = document.getElementById('last-updated');
const searchEl = document.getElementById('search');
const presentCountEl = document.getElementById('present-count');
const totalCountEl = document.getElementById('total-count');

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-ANON')) {
  boardEl.innerHTML = '<p class="text-muted dark:text-muteddark text-center py-8 col-span-full">Set SUPABASE_URL and SUPABASE_ANON_KEY in web/config.js to load the board.</p>';
  throw new Error('config.js still has placeholder Supabase credentials');
}

// All attendance objects live in the `dosen4` Postgres schema (not
// `public`) — see ../supabase/schema.sql. It must be added to Supabase's
// "Exposed schemas" (Project Settings -> API) or every call below 404s.
const DB_SCHEMA = 'dosen4';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { db: { schema: DB_SCHEMA } });

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
// chooses), not a strict present/absent/private enum -- only these three
// values get their own dedicated tab treatment; anything else is a manual
// override and gets a neutral "custom status" tab showing the text as-is.
function statusTab(status) {
  if (status === 'present') return { label: 'MASUK', classes: 'bg-presentsoft dark:bg-presentsoftdark text-present dark:text-presentdark' };
  if (status === 'absent') return { label: 'KELUAR', classes: 'bg-absentsoft dark:bg-absentsoftdark text-absentc dark:text-absentcdark' };
  if (status === 'private') return { label: 'PRIBADI', classes: 'bg-surface2 dark:bg-surfacedark2 text-muted dark:text-muteddark' };
  return { label: status.toUpperCase(), classes: 'bg-brasssoft dark:bg-brasssoftdark text-brass dark:text-brassdark' };
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

  const presentCount = all.filter((r) => r.status === 'present').length;
  presentCountEl.textContent = String(presentCount);
  totalCountEl.textContent = `/ ${all.length} hadir sekarang`;

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
    .subscribe();
}

searchEl.addEventListener('input', render);
setInterval(render, 15000); // keep relative timestamps fresh even with no new events

loadInitial().then(subscribeRealtime);
