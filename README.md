# 5LC Task Control

A simple, mobile-first **Task & Accountability** app for **FIVE LASER CUT**.
One Android APK with role-based screens: Director (company-wide control),
Head/Manager (team + downline), Employee (own tasks). Backend authority lives in
Supabase (PostgreSQL + RLS + RPC); the APK is only the interface.

> Every commitment gets an owner. Every owner gets a deadline. Every deadline
> gets tracked. Every delay has a reason. Every completion is recorded.

## Stack
- **App:** Expo + Expo Router + React Native + TypeScript (Android)
- **Backend:** Supabase (PostgreSQL, Auth, Row Level Security, RPC) — see `supabase/`
- **Push:** Firebase Cloud Messaging via `expo-notifications`

## Structure
```
src/
  app/            Expo Router screens
                    index            login (Employee ID + password)
                    forgot-password  reset link by email
                    dashboard        role-aware KPIs + quick actions
                    tasks            my tasks
                    task-detail      status, comments, history, extension,
                                     delegation chain (parent + sub-tasks)
                    create-task      create / delegate a sub-task
                    extensions       approve / reject requests
                    notifications    in-app notification feed
                    team             my downline + open workloads
                    reports          status breakdown + most overdue
                    recurring        repeat task templates
                    settings         profile, sign out
  constants/      brand palette + shared status/priority/reason labels
  lib/            supabase client + auth helpers + push registration
supabase/
  migrations/     Database schema + RLS + RPC + escalation engine (backend-as-code)
  functions/      dispatch-notifications (FCM push + email delivery)
assets/           App icon + brand logo only (kept minimal for a small APK)
```

## Features
- **Roles & hierarchy** enforced in the database (RLS), not in the app
- Login by **Employee ID**, password reset by email
- Create / assign / **delegate sub-tasks** (full chain visible, drill-down)
- Status lifecycle: Not Started / In Progress / Waiting / Completed / Rejected
- Priorities: Low / Normal / High / Urgent
- **Overdue tracking + escalation** (configurable thresholds in `system_settings`)
- **Extension workflow** with reason categories and approver decision
- **Automatic reminders**: due-today, morning pending, daily overdue, escalation
  (pg_cron → notification rows; `dispatch-notifications` delivers push + email)
- **Recurring tasks** (daily / weekly / monthly templates)
- Immutable **audit history** per task; comments
- Director/Manager **team + reports** views


## Develop
```bash
npm install
npx expo start          # dev server (use a development build for push)
npm run typecheck       # tsc --noEmit
```

## Build the release APK
```bash
npx eas-cli build --platform android --profile production
```

## Security model (important)
Role and hierarchy are enforced **in the database** (`supabase/migrations/0003`
and `0004`), never only by hiding UI in the app. Do not weaken those policies.

**Read [`SECURITY.md`](./SECURITY.md)** for the full security model, the public
vs secret key rules, the dashboard settings to apply, and the security audit
script (`supabase/diagnostics/security_audit.sql`).
