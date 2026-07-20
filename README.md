# rdosen4 — attendance web platform + Supabase backend

Static GitHub Pages site that shows a live present/absent board, backed by
Supabase. Presence data is written by the `ada` agent (sibling directory) —
this project owns the database schema it reads from, but has no code
dependency on `ada`; the two only share a Supabase project.

## 1. Set up the Supabase backend

1. Create a Supabase project (or use an existing one).
2. Open the SQL editor and run `supabase/schema.sql`. It's idempotent — safe
   to re-run any time the file changes. This creates a dedicated **`dosen4`
   schema** (not `public`) containing:
   - `users`, `devices` (the MAC allowlist), `presence`, `attendance_log`
   - `presence_board` — the public, name+status-only read view
   - `report_presence(...)` — a `SECURITY DEFINER` RPC, callable only by
     `service_role`, that the `ada` agent uses to push updates
   - RLS locked down so `anon`/`authenticated` can only read
     `presence_board` — never the raw tables (no MAC addresses or
     identifiers are exposed publicly)
   - Adds `presence` to the `supabase_realtime` publication
   - A trigger on `auth.users` that auto-creates a `dosen4.users` profile on
     every Google sign-in, and `register_device`/`remove_device` RPCs that
     let a signed-in `@polinema.ac.id` user manage their own devices — see
     "Google sign-in setup" below.
3. **Expose the `dosen4` schema**: Dashboard → Project Settings → API →
   "Exposed schemas" → add `dosen4`. PostgREST only serves schemas on this
   list, so skipping this step makes every REST/RPC call 404. (SQL
   equivalent: `alter role authenticator set pgrst.db_schemas = 'public, dosen4, graphql_public'; notify pgrst, 'reload config';`)
4. (Optional, for testing) run `supabase/seed.sql`, replacing the sample
   MAC address with your own laptop/phone's MAC on the campus SSID — see
   `../ada/README.md` for the MAC-randomization caveat.
5. From **Project Settings → API**, grab:
   - the **Project URL** and **anon/publishable key** → set as GitHub Actions
     repo secrets (see below), never committed to the repo
   - the **service_role/secret key** → used by `../ada/.env` (keep secret,
     never put it here or in GitHub Actions secrets for this repo)

## 2. Configure the frontend

`web/config.js` is **not committed** (it's gitignored) — it's generated at
deploy time by `.github/workflows/deploy-pages.yml` from two **GitHub
Actions repository secrets**:

1. Repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `SUPABASE_URL` — your Project URL
   - `SUPABASE_ANON_KEY` — your anon/publishable key
2. Every deploy regenerates `web/config.js` from these secrets before
   publishing. If either is unset, the workflow fails fast with a clear
   error instead of shipping a broken site.

This applies even though the anon/publishable key is designed to be safe
for client-side exposure (it can only do what RLS allows) — it still
shouldn't be hardcoded into tracked source; secrets keep it out of git
history and make rotation a one-click change.

For **local testing** (no deploy), copy the template and fill it in
yourself — this file stays untracked:

```bash
cd rdosen4/web
cp config.example.js config.js   # gitignored, safe to fill in locally
# edit config.js: SUPABASE_URL and SUPABASE_ANON_KEY
```

Open `web/index.html` directly in a browser to test locally (no build
step, no server required — it's plain HTML/JS with `supabase-js` and
Tailwind (via the Play CDN, `cdn.tailwindcss.com`) both loaded from a
CDN — no `styles.css`/build pipeline).

## 3. Deploy to GitHub Pages

1. Push this repo to GitHub.
2. In the repo settings, set **Pages → Source: GitHub Actions**.
3. Add the `SUPABASE_URL` and `SUPABASE_ANON_KEY` repository secrets (see
   above) — the deploy fails without them.
4. `.github/workflows/deploy-pages.yml` publishes the `web/` folder on
   every push to `main` that touches it (or via manual "Run workflow").

### Custom domain (`dosen4.makinmudah.com`)

`web/CNAME` already contains `dosen4.makinmudah.com`, and `actions/deploy-pages`
carries it into the deploy, which sets the repo's Pages custom domain
automatically. The one step that has to happen outside this repo: in the
`makinmudah.com` DNS zone, add

```
dosen4  CNAME  dhanifudin.github.io.
```

GitHub issues the HTTPS certificate once DNS and the `CNAME` file agree —
this can take a few minutes after the record propagates. Check status
under repo **Settings → Pages**.

## Google sign-in setup (for device registration)

`web/register.html` lets a signed-in user register their own device's MAC
address (up to 5 per person). Google sign-in itself doesn't restrict by
email domain — that's enforced by this app (client-side check for UX, and
the `register_device` RPC as the real gate: any Google account can sign in
and get a profile row, but only `@polinema.ac.id` accounts can actually
register a device). Two one-time setup steps in external dashboards, not
something this repo can do on its own:

1. **Google Cloud Console** → create an OAuth 2.0 Client ID (APIs & Services
   → Credentials → Create Credentials → OAuth client ID → Web application).
   - Authorized redirect URI: `https://<your-project-ref>.supabase.co/auth/v1/callback`
     (find `<your-project-ref>` in the Supabase Project URL).
   - Copy the generated **Client ID** and **Client Secret**.
2. **Supabase Dashboard** → Authentication → Providers → **Google** → enable
   it, paste the Client ID/Secret from step 1, save.
3. **Supabase Dashboard** → Authentication → URL Configuration → **Redirect
   URLs** → add:
   - `https://dosen4.makinmudah.com/register.html`
   - (optionally) the default `*.github.io` Pages URL as a fallback, if you
     ever test before the custom domain is live.

Once both are done, `register.html` "Sign in with Google" works end to end.
No further code changes needed on this side — the `hd=polinema.ac.id` query
param on the sign-in call just pre-filters Google's account picker to the
org as a UX nicety; it isn't itself an access control (hence the app-level
check described above).

For bulk/admin registration (e.g. a legacy user with no Google account),
add rows to `users`/`devices` directly via Supabase Studio's table editor
or `insert` statements like `supabase/seed.sql` — unaffected by the above.

### Auto-detected registration (no typing, no manual MAC entry)

The primary flow on `register.html` doesn't ask for a MAC at all: the user
clicks "Detect my device", turns Wi-Fi off then back on per the on-screen
instructions, and the currently-running `ada` agent (which has the LAN
visibility a browser never can) correlates "who just started a detection
window" with "what MAC just freshly reappeared on the network" and
registers it automatically. Works identically for phones and laptops.

This **requires the `ada` agent to be running** against the same Supabase
project — it's what actually observes the network and resolves the
window (`dosen4.observe_macs_for_detection`, called every scan cycle). If
the agent is down, detection windows will just expire with no matches.
At most one detection window is open campus-wide at a time (enforced in
Postgres), so two people can't register simultaneously — the second gets
a "someone else is registering right now" message and can retry shortly.

Manual MAC entry (`register_device`) is kept as a fallback under "On a
phone and detection didn't work? Enter the MAC manually" — same iOS/
Android/Windows/Mac lookup hints as before, in case reconnect detection
repeatedly fails for someone.

## Architecture recap

```
ada agent  --(service_role key, RPC)-->  Supabase  --(anon key, Realtime)-->  web/ (GitHub Pages)
```
