# 5LC Task Control — Security Model & Hardening Guide

This document explains **how the app is protected**, what is secret vs public,
and the exact settings to apply in the Supabase dashboard so nobody can breach
the system from outside.

> Core rule (from the product blueprint): **the backend is the authority; the
> APK is only the interface.** An attacker can decompile the APK and see all of
> its code and the public keys — and still cannot do anything they are not
> allowed to do, because Postgres enforces every rule.

---

## 1. The defense layers (in order)

| # | Layer | Where | What it does |
|---|-------|-------|--------------|
| 1 | **Authentication** | Supabase Auth | Only registered members get a session. Public sign-up must be DISABLED (see §4) |
| 2 | **Row Level Security** | Postgres (`0004_rls_policies.sql`) | Every read/write is filtered by role + hierarchy in the database itself |
| 3 | **Security-definer helpers** | `0003_security_helpers.sql` | `current_role()`, `is_director_or_admin()`, `is_self_or_downline()`, `can_assign_to()` — single source of truth |
| 4 | **RPC authority checks** | `0005_review_extension_rpc.sql` | Extension approvals re-verify the reviewer's hierarchy server-side |
| 5 | **Edge Function auth** | `manage-user`, `dispatch-notifications` | `manage-user` verifies the caller is Director/Super Admin from their JWT; `dispatch-notifications` requires a secret |
| 6 | **DB triggers** | `0010_audit_triggers.sql` | Audit history + notifications are written by the database — the app cannot skip or fake them |
| 7 | **On-device storage** | `lib/supabase.ts` | Session tokens live in Android Keystore-backed `expo-secure-store`, not plain files |

If ANY single layer fails, the others still hold.

---

## 2. Public vs secret keys — CRITICAL

| Key | Where it lives | Is it a secret? |
|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | `.env`, inside the APK | **Public by design** |
| `EXPO_PUBLIC_SUPABASE_KEY` (anon/publishable) | `.env`, inside the APK | **Public by design** — useless beyond what RLS allows |
| `google-services.json` | repo + APK | Public by design (Google's client config) |
| **SUPABASE_SERVICE_ROLE_KEY** | Supabase Edge Function secrets only | **TOP SECRET** — bypasses ALL RLS. Never in the app, never in Git, never in screenshots |
| **FCM service account JSON** | Edge Function secret `FCM_SERVICE_ACCOUNT` | **SECRET** — never commit (gitignored as `service-account*.json`) |
| **RESEND_API_KEY** | Edge Function secret | **SECRET** |
| **DISPATCH_SECRET** | Edge Function secret + cron job | **SECRET** — protects the notification dispatcher |

**If the service_role key or FCM key ever leaks** (screenshot, Git, chat):
rotate it immediately — Supabase Dashboard → Project Settings → API →
"Generate new service_role key" (old app installs keep working; they use the
anon key only).

---

## 3. What a breach attempt looks like vs. what actually happens

| Attack | Result |
|---|---|
| Someone decompiles the APK, finds the anon key | They can sign in **only with real employee credentials**, and then only see what their role allows |
| Someone calls the API directly (Postman) with the anon key, no login | Every table has RLS → **zero rows** |
| Employee edits the app to call "create task for anyone" | `can_assign_to()` returns false server-side → **denied** |
| Employee tries to approve their own extension | RPC checks authority + self-review → **denied** |
| Someone finds the dispatch-notifications URL | `401 Unauthorized` without `DISPATCH_SECRET` |
| Someone steals a phone | Token lives in Keystore; sign out / deactivate the member from Manage Members |

---

## 3b. Permission rules (who can do what)

| Action | Employee | Manager / Head | Director | Super Admin |
|---|---|---|---|---|
| See tasks | **own only** | own + **their downline** | **company-wide** | company-wide |
| Create/assign tasks | **self only** ✅ | **self + downline** | anyone | anyone |
| Delegate sub-tasks | ❌ | downline only | anyone | anyone |
| Review extensions | ❌ | **their downline only** | **only if in that person's chain** | support override |
| See My Team | ❌ (Alerts instead) | own downline | whole company | whole company |
| Register members | ❌ | ❌ | ✅ | ✅ |
| Set hierarchy (who reports to whom) | ❌ | ❌ | ✅ | ✅ |
| Reports | ❌ | their downline scope | company-wide | company-wide |

Two rules worth remembering:
- **Extensions never go blanket to the Director.** A request is routed to the
  requester's **upline** (manager → higher). The Director only sees it if they
  are in that person's reporting chain, or if the member has no manager (then
  their director approves so nothing gets stuck).
- **Every account controls only its own downline.** The only blanket exceptions
  are the Director (whole company) and Super Admin (system operator).

These are enforced in Postgres (migrations `0004`, `0013`) - not in the app UI.

---

## 4. Supabase dashboard settings to apply (one-time, ~10 minutes)

**Authentication → Sign In / Providers:**
- ❌ **"Allow new users to sign up" → OFF.** Members are created only through
  the app by the Director (the `manage-user` function). With this off, nobody
  can self-register even with the public anon key.
- ❌ **Anonymous sign-ins → OFF.**

**Authentication → Passwords:**
- Minimum password length: **8**
- ✅ **Leaked password protection** (checks against HaveIBeenPwned) → ON

**Authentication → Sessions:**
- JWT expiry: 3600s (default) is fine
- ✅ Refresh token rotation → ON (default)

**Authentication → URL Configuration:**
- Add redirect URL: `flctaskcontrol://reset` (needed for invite/reset email
  links to open the app)

**Database → Extensions:** only enable what we use (`pg_cron`, `pg_net`).

---

## 5. Ongoing: the 60-second security audit

Run `supabase/diagnostics/security_audit.sql` in the SQL Editor monthly
(or after any schema change). Every numbered section should return **zero rows**
(except §3 and §6, which are review-only). If a new table appears in §1,
enable RLS on it immediately.

Also periodically check for old permissive policies:
`supabase/diagnostics/list_policies.sql`.

---

## 6. App-side rules (for anyone editing this code)

1. **Never** bypass or weaken RLS to "make something work" — fix the policy.
2. **Never** trust the client for permissions. Hiding a button is UX only.
3. **Never** add the service_role key to the app, `.env`, or Git.
4. **Never** insert into `task_history` from the app — triggers own it.
5. New tables → enable RLS **in the same migration that creates them**.
6. New Edge Functions → verify the caller (JWT + role) or a secret, like the
   existing ones.
7. No file/attachment uploads — this is a hard product rule and also removes
   a whole class of storage-bucket attack surface.
8. Keep dependencies updated: `npx expo install --fix` + `npm audit` monthly.

---

## 7. If something goes wrong

1. **Rotate the leaked key** (Supabase → API settings; Firebase → service accounts; Resend → API keys).
2. **Deactivate the affected member** in Manage Members (blocks their login).
3. Check `task_history` + Supabase logs (Dashboard → Logs) for what happened.
4. Fix the cause, then redeploy.

