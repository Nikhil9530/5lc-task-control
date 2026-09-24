// 5LC Task Control - manage-user
// Member management from the app. ONLY Director / Super Admin may call it.
// Actions: create | update | set_active | reset_password
// The caller's role is verified SERVER-SIDE from their JWT - the app is only UI.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const ROLES = ['super_admin', 'director', 'head', 'manager', 'employee'];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function tempPassword(): string {
  // No ambiguous characters (no 0/O, 1/l/I).
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let p = '';
  for (let i = 0; i < 12; i++) {
    p += chars[Math.floor(Math.random() * chars.length)];
  }
  return p;
}

async function requireDirector(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  if (!token) return { error: json({ error: 'Not authenticated' }, 401) };

  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return { error: json({ error: 'Not authenticated' }, 401) };

  const { data: caller } = await db
    .from('profiles')
    .select('id, role')
    .eq('id', data.user.id)
    .single();

  if (!caller || !['director', 'super_admin'].includes(caller.role)) {
    return { error: json({ error: 'Only Director or Super Admin can manage members' }, 403) };
  }
  return { caller };
}

Deno.serve(async (req) => {
  const auth = await requireDirector(req);
  if (auth.error) return auth.error;
  const caller = auth.caller!;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const action = body?.action;

  try {
    // ---------------- CREATE ----------------
    if (action === 'create') {
      const employee_id = String(body.employee_id ?? '').trim().toUpperCase();
      const full_name = String(body.full_name ?? '').trim();
      const email = String(body.email ?? '').trim().toLowerCase();
      const role = String(body.role ?? 'employee');
      const department = body.department ? String(body.department).trim() : null;
      const manager_id = body.manager_id || null;
      let director_id = body.director_id || null;
      if (caller.role === 'director' && !director_id) director_id = caller.id;

      if (!employee_id || !full_name || !email) {
        return json({ error: 'Employee ID, full name and email are required' }, 400);
      }

      if (!ROLES.includes(role)) return json({ error: 'Invalid role' }, 400);

      if (
  ['director', 'super_admin'].includes(role) &&
  caller.role !== 'super_admin'
) {
  return json(
    { error: 'Only Super Admin can create Director or Super Admin accounts' },
    403
  );
}

      const { data: dup } = await db
        .from('profiles')
        .select('id')
        .or(`employee_id.eq.${employee_id},email.eq.${email}`)
        .maybeSingle();
      if (dup) return json({ error: 'Employee ID or email already exists' }, 409);

      const password = tempPassword();
      const { data: created, error: cErr } = await db.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name, employee_id },
      });
      if (cErr) return json({ error: cErr.message }, 400);

      const { error: pErr } = await db.from('profiles').insert({
        id: created.user.id,
        employee_id,
        full_name,
        email,
        role,
        department,
        manager_id,
        director_id,
        is_active: true,
      });
      if (pErr) {
        // Roll back the auth user so no orphan account is left.
        await db.auth.admin.deleteUser(created.user.id);
        return json({ error: 'Profile creation failed: ' + pErr.message }, 500);
      }

      // Best-effort invite email (Supabase built-in; rate-limited on free tier).
      // The link deep-opens the app (flctaskcontrol://) so the member can sign
      // in and set their own password. Temp password below is the fallback.
      let invite_email_sent = false;
      try {
        await db.auth.admin.inviteUserByEmail(email, {
          redirectTo: 'flctaskcontrol://reset',
        });
        invite_email_sent = true;
      } catch {
        // Rate limit or email config issue - the temp password still works.
      }

      return json({ ok: true, user_id: created.user.id, temp_password: password, invite_email_sent });
    }


    // ---------------- UPDATE PROFILE ----------------
if (action === 'update') {
  if (!body.user_id) {
    return json({ error: 'user_id required' }, 400);
  }

  const { data: target, error: targetError } = await db
    .from('profiles')
    .select('id, role, director_id')
    .eq('id', body.user_id)
    .single();

  if (targetError || !target) {
    return json({ error: 'User not found' }, 404);
  }

  // Director may only manage members belonging to their own director scope.
  if (
    caller.role === 'director' &&
    target.director_id !== caller.id
  ) {
    return json(
      { error: 'You can only manage members in your own hierarchy' },
      403
    );
  }

  if (body.role && !ROLES.includes(body.role)) {
    return json({ error: 'Invalid role' }, 400);
  }

  // Only Super Admin can create/promote someone to Director or Super Admin.
  if (
    body.role &&
    ['director', 'super_admin'].includes(body.role) &&
    caller.role !== 'super_admin'
  ) {
    return json(
      { error: 'Only Super Admin can assign Director or Super Admin roles' },
      403
    );
  }

  const patch: any = {};

  for (const f of [
    'full_name',
    'role',
    'department',
    'manager_id',
    'director_id',
  ]) {
    if (f in body) {
      patch[f] = body[f];
    }
  }

  // Director cannot move a member into another Director's hierarchy.
  if (
    caller.role === 'director' &&
    'director_id' in patch &&
    patch.director_id !== caller.id
  ) {
    return json(
      { error: 'You cannot move a member to another Director hierarchy' },
      403
    );
  }

  const { error } = await db
    .from('profiles')
    .update(patch)
    .eq('id', body.user_id);

  if (error) {
    return json({ error: error.message }, 400);
  }

  return json({ ok: true });
}

    // ---------------- ACTIVATE / DEACTIVATE ----------------
    if (action === 'set_active') {
      if (!body.user_id || typeof body.is_active !== 'boolean') {
        return json({ error: 'user_id and is_active required' }, 400);
      }
      const { error } = await db
        .from('profiles')
        .update({ is_active: body.is_active })
        .eq('id', body.user_id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // ---------------- RESET PASSWORD ----------------
    // Reliable for an internal app: set a fresh temp password the Director
    // shares privately; the member changes it in Settings afterwards.
    if (action === 'reset_password') {
      if (!body.user_id) return json({ error: 'user_id required' }, 400);
      const pw = tempPassword();
      const { error } = await db.auth.admin.updateUserById(body.user_id, { password: pw });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, temp_password: pw });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});

