# rdosen4 — attendance web platform + Supabase backend

Static GitHub Pages site that shows a live present/absent board, backed by
Supabase. Presence data is written by the `ada` agent (sibling directory) —
this project owns the database schema it reads from, but has no code
dependency on `ada`; the two only share a Supabase project.

## 1. Set up the Supabase backend

1. Create a Supabase project (or use an existing one).
2. Open the SQL editor and run `supabase/schema.sql`. This creates a
   dedicated **`dosen4` schema** (not `public`) containing:
   - `users`, `devices` (the MAC allowlist), `presence`, `attendance_log`
   - `presence_board` — the public, name+status-only read view
   - `report_presence(...)` — a `SECURITY DEFINER` RPC, callable only by
     `service_role`, that the `ada` agent uses to push updates
   - RLS locked down so `anon`/`authenticated` can only read
     `presence_board` — never the raw tables (no MAC addresses or
     identifiers are exposed publicly)
   - Adds `presence` to the `supabase_realtime` publication
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
step, no server required — it's plain HTML/CSS/JS with `supabase-js`
loaded from a CDN).

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

## Registering people & devices

For the MVP, add rows to `users` and `devices` directly via Supabase
Studio's table editor (or `insert` statements like `supabase/seed.sql`).
A self-service registration page (Supabase Auth + magic link) is a natural
follow-up but out of scope for the first pass.

## Architecture recap

```
ada agent  --(service_role key, RPC)-->  Supabase  --(anon key, Realtime)-->  web/ (GitHub Pages)
```
