# 5LC Task Control — Go-Live Checklist

Everything is coded. What remains is one-time setup using YOUR accounts
(Supabase, Firebase, Resend, Expo). Do these in order. ~45–60 minutes total.

> **Security first:** complete **STEP 0** and then read `SECURITY.md`. It is the
> full picture of how the app is protected and what to verify.

---

## STEP 0 — Lock down public sign-up (Supabase Dashboard, 5 minutes)

**Authentication → Sign In / Providers:**
- ❌ **"Allow new users to sign up" → OFF**
  (members are added only by the Director through the app)
- ❌ **Anonymous sign-ins → OFF**

**Authentication → Passwords:**
- Minimum password length → **8**
- ✅ **Leaked password protection → ON**

Full details + rationale: `SECURITY.md` §4.

---

## STEP 1 — Apply the database migrations (Supabase Dashboard)

1. Open **Supabase Dashboard → your project → SQL Editor**.
2. First run `supabase/diagnostics/list_policies.sql` and check for old
   permissive policies. Postgres ORs policies together — drop any old policy
   that is too broad (`drop policy "name" on public.table;`).
3. Run these files in order (New query → paste → Run):
   - `0001_core_schema.sql`
   - `0002_more_tables.sql`
   - `0003_security_helpers.sql`
   - `0004_rls_policies.sql`
   - `0005_review_extension_rpc.sql`
   - `0006_notifications_view.sql`
   - `0007_settings_recurring.sql`
   - `0008_escalation_engine.sql`
   - `0009_recurring_cron.sql`  (schedules daily checks at 09:00 IST)
   - `0010_audit_triggers.sql`
   - `0011_assignment_email_channel.sql`
   - `0012_profiles_directory.sql`  (company directory read access)
   - `0013_upline_only_approvals.sql` (extensions go to the upline, not the Director)
   - `0014_notify_upline_extension.sql` (upline notified on extension request)
   - `0015_my_downline.sql`         (server-side downline scoping)
   - `0016_self_task_creation.sql`  (everyone can create tasks for themselves)
   - `0017_delegation_role_gate.sql` (only manager and above may delegate)
   - `0018_auth_lookup_rpcs.sql`    (Employee ID -> email for Sign In + Forgot Password)
4. **Test security:** log in as a manager, try to assign a task to someone
   OUTSIDE their downline → must be denied. Log in as an employee, try to
   create a task → must be denied.
5. Run `supabase/diagnostics/security_audit.sql` → every section must be empty
   (see `SECURITY.md`).

---

## STEP 2 — Deploy the Edge Functions

In a terminal at the project root:

```bash
npx supabase login
npx supabase link --project-ref hmyggerfpiizcwhdthvd

npx supabase functions deploy dispatch-notifications --no-verify-jwt
npx supabase functions deploy manage-user
```

After this, **Dashboard → Add Member** in the app works — Directors can register
people without ever opening the Supabase dashboard.

---

## STEP 3 — Push notifications (Firebase / FCM)

You already created the Firebase project `flc-task-control` and
`google-services.json`. The one remaining piece is the **service account JSON**
(the thing that confused you in the ChatGPT chat):

1. Open **Firebase Console → flc-task-control → Project settings (gear icon)**
2. Tab **Service accounts** → click **Generate new private key** → download the JSON
3. Set the secrets for the Edge Function:

```bash
npx supabase secrets set FCM_PROJECT_ID=flc-task-control
npx supabase secrets set FCM_SERVICE_ACCOUNT="$(cat path\to\your-service-account.json)"
npx supabase secrets set DISPATCH_SECRET="<a-long-random-string-you-invent>"
```

(**DISPATCH_SECRET** is required — it stops strangers from triggering the
notification sender once the URL is known. Also used in STEP 5.)

(On PowerShell use: `npx supabase secrets set FCM_SERVICE_ACCOUNT=(Get-Content path\to\file.json -Raw)`)

---

## STEP 4 — Email notifications (Resend, free)

Supabase's built-in email is rate-limited (~3/hour) — fine for password resets,
too slow for task notifications. Resend free tier = 3,000 emails/month.

1. Sign up at **resend.com** (free)
2. **Domains → Add Domain** → add your company domain and verify it with the
   DNS records they give you (your domain provider / GoDaddy / Cloudflare)
3. Create an **API Key**
4. Set secrets:

```bash
npx supabase secrets set RESEND_API_KEY=re_xxxxxxxx
npx supabase secrets set EMAIL_FROM="5LC Tasks <no-reply@yourdomain.com>"
```

(If you have no domain yet, Resend lets you send from `onboarding@resend.dev`
to test — emails may land in spam; add a domain before real rollout.)

---

## STEP 5 — Schedule the notification dispatcher

The dispatcher reads pending notifications and delivers push + email.
Run this **once** in the SQL Editor (Supabase → SQL Editor):

```sql
create extension if not exists pg_net;

select cron.schedule(
  'dispatch-notifications', '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://hmyggerfpiizcwhdthvd.supabase.co/functions/v1/dispatch-notifications',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer PASTE_YOUR_DISPATCH_SECRET_HERE'
       )
     ); $$
);
```

Replace `PASTE_YOUR_DISPATCH_SECRET_HERE` with the same value you set in STEP 3.

> The secret lives in the database (the trusted boundary) — that is expected for
> an internal company app. Nobody outside can read it; RLS prevents all table reads.

---

## STEP 5b — Auth redirect for invite / reset email links

**Supabase Dashboard → Authentication → URL Configuration → Redirect URLs → Add:**
```
flctaskcontrol://reset
```

This lets the invite/password-reset links open the app directly (the app already
handles them in `src/app/_layout.tsx`).

---

## STEP 6 — Build the production APK

```bash
npm install -g eas-cli
eas login
eas build --profile production --platform android
```

Wait ~15 min → download the APK → install on YOUR phone first and test.

**Update strategy without Play Store:** for app updates use
`eas update` (over-the-air, instant) — no new APK download needed for most changes.

---

## STEP 7 — End-to-end acceptance test (from your blueprint)

On two phones (or phone + emulator):

- [ ] Director login → sees company-wide numbers
- [ ] Manager login → only their downline
- [ ] Employee login → only their tasks
- [ ] Director assigns task → assignee gets **push + email** within ~5 min
- [ ] Manager assigns outside downline → **denied**
- [ ] Task passes due date → next morning: overdue reminder + escalation
- [ ] Employee requests extension (with reason category) → manager approves →
      new due date recorded, history updated
- [ ] Employee marks complete → assigner notified
- [ ] Recurring task → next occurrence auto-created
- [ ] Dashboard → Add Member → new person can log in

---

## STEP 8 — Rollout

1. Pilot with 3–5 internal people for a week
2. Add everyone via **Add Member** (invite email or temp password)
3. Hand out the APK + a one-page "how to use" note
4. Watch `notifications.delivery_status` for any `failed` rows

---

## Daily-use summary (after go-live)

| Action | Where |
|---|---|
| Register a person | App → Dashboard → Add Member |
| Assign / delegate a task | App → Create Task (or Delegate on a task) |
| Approve extensions | App → Extension Requests |
| Monitor company | App → Dashboard / Reports |
| Change escalation rules | Supabase → `system_settings` row (or ask me to build a settings UI) |
| Check failed notifications | Supabase → `notifications` table, `delivery_status = 'failed'` |
