# 5LC Task Control — Backend as Code

All backend logic for the app lives here, **versioned in Git** (previously it only
existed in the Supabase dashboard, which was a single point of loss).

> The APK is only the user interface. **These SQL files are the real security
> boundary** — role and hierarchy are enforced by Postgres RLS + RPC, not by
> hiding buttons in the app.

## What's here

```
supabase/
  migrations/
    0001_core_schema.sql         profiles, tasks, task_comments
    0002_more_tables.sql         task_extensions, task_history, notifications, device_tokens
    0003_security_helpers.sql    current_role(), is_director_or_admin(),
                                 is_self_or_downline(), can_assign_to()   <- security core
    0004_rls_policies.sql        Row Level Security on every table
    0005_review_extension_rpc.sql review_task_extension() with server-side authority check
    0006_notifications_view.sql  notifications_with_names (feeds the Notifications screen)
    0007_settings_recurring.sql  system_settings (configurable escalation), recurring_tasks
    0008_escalation_engine.sql   delivery status + dedupe, run_daily_task_checks()
    0009_recurring_cron.sql      generate_recurring_tasks() + pg_cron schedules
    0010_audit_triggers.sql      history + assignment notifications via DB triggers
    0011_assignment_email_channel.sql  assignment notifications = push + email
  functions/
    dispatch-notifications/      sends pending notifications via FCM push + email
    manage-user/                 Director-only member management from the app
                                 (create / update / activate / reset password)
```

## Live schema confirmed (via API on 2026-09-20)

Existing: `profiles, tasks, task_comments, task_extensions, task_history,
notifications, device_tokens, notifications_with_names (view)`.

Not present (and intentionally not built yet): `departments`, `roles`,
`system_settings`, `recurring_tasks` — `department`/`role` are text columns on
`profiles` for simplicity at this company size (~50 users).

## How to apply (no Docker / CLI needed)

> **STEP 0 (important): run `diagnostics/list_policies.sql` first.**
> Your existing policies were created in the dashboard. Postgres **ORs**
> permissive policies, so old broad policies would keep users bypassing the new
> hardened ones. Review the list, `drop policy "<name>" on public.<table>;` for
> anything too permissive, then apply the migrations.

1. Open your project in the **Supabase Dashboard → SQL Editor**.
2. Run the migration files **in order** (`0001` → `0010`).
3. They are written to be **idempotent** (`if not exists`, `drop policy if exists`,
   `create or replace`), so they are safe to re-run on the existing project.
4. The only **new behavior** is the security hardening in `0003`–`0005` and the
   automation in `0007`–`0010`. Test with a manager + employee account afterward
   (a manager should NOT be able to assign outside their downline, and an
   employee should NOT be able to create tasks).

## What changed vs. the old app behavior (the security fix)

Before: `create-task` and `extensions` checked hierarchy **in JavaScript on the
phone** — bypassable. After: `can_assign_to()` and `review_task_extension()`
re-check authority **in Postgres**. The APK still hides invalid options for good
UX, but the database is now the authority (blueprint non-negotiable).

## Automation (migrations 0007–0009)

- **Escalation rules are configurable** in `system_settings` (day thresholds for
  manager/head/director, urgent overrides, quiet hours, email/push switches).
- **`run_daily_task_checks()`** creates: due-today reminders, morning pending
  reminders, daily overdue reminders, and escalations to the right level.
  It is **idempotent** (`dedupe_key`) so re-running never duplicates a message.
- **`generate_recurring_tasks()`** creates one normal task per occurrence, each
  with its own id + history, and advances `next_run_date`.
- Scheduled with **pg_cron** (09:00 IST = `30 3 * * *` UTC). If pg_cron is not
  available on your plan, call both functions from any external scheduler.
- **`dispatch-notifications` Edge Function** is the delivery step: it reads
  `notifications` where `delivery_status='pending'`, sends Android push (FCM v1)
  and email, then records `sent`/`failed` + `channel`.

### Deploy the Edge Functions

```bash
npx supabase functions deploy dispatch-notifications --no-verify-jwt
npx supabase functions deploy manage-user

npx supabase secrets set FCM_PROJECT_ID=flc-task-control \
  FCM_SERVICE_ACCOUNT="$(cat service-account.json)" \
  RESEND_API_KEY=re_xxx EMAIL_FROM=no-reply@yourdomain.com
```

`manage-user` is called from the app (Dashboard -> Add Member) by Directors and
Super Admins only - the caller's role is verified inside the function.

Schedule it every 5 minutes (Supabase Cron or external), then test.

## Still to build (optional, not required for launch)

- Calendar event sync (intentionally skipped — not needed for accountability)
