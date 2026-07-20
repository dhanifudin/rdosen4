import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// All attendance objects live in the `dosen4` Postgres schema (not
// `public`) -- see ../supabase/schema.sql. It must be added to Supabase's
// "Exposed schemas" (Project Settings -> API) or every call below 404s.
export const DB_SCHEMA = 'dosen4';
export const REQUIRED_DOMAIN = '@polinema.ac.id';

// Computed once here so every page (index.html, devices.html) shows the
// same "not configured" signal instead of each re-deriving it -- but the
// actual error UI stays page-specific, since each page has its own notice
// element to render into.
export const configOk = Boolean(
  SUPABASE_URL && SUPABASE_ANON_KEY &&
  !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR-ANON'),
);

// Constructed even when misconfigured (with harmless placeholders) so this
// module never throws at import time -- callers check `configOk` first and
// bail with their own page-specific message before making any real call.
export const supabase = createClient(
  configOk ? SUPABASE_URL : 'https://placeholder.supabase.co',
  configOk ? SUPABASE_ANON_KEY : 'placeholder-key',
  { db: { schema: DB_SCHEMA } },
);

export async function signInWithGoogle() {
  const redirectTo = window.location.origin + window.location.pathname;
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, queryParams: { hd: 'polinema.ac.id' } },
  });
}

/**
 * Client-side soft block (the RPCs enforce the same domain check
 * server-side, regardless): if a session exists but its email isn't on the
 * required domain, sign it out immediately. Returns the email if the
 * session is valid for this app, otherwise null (including "no session").
 */
export async function checkDomainOrSignOut(session) {
  if (!session) return null;
  const email = session.user.email || '';
  if (!email.toLowerCase().endsWith(REQUIRED_DOMAIN)) {
    await supabase.auth.signOut();
    return null;
  }
  return email;
}
