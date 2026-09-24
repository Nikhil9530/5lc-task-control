// 5LC Task Control - dispatch-notifications
// Reads pending notifications, sends Android PUSH (FCM v1) and EMAIL, then
// records delivery status. Idempotent: only rows with delivery_status='pending'
// are processed, and they are marked sent/failed afterward.
//
// Deploy:  npx supabase functions deploy dispatch-notifications --no-verify-jwt
// Secrets: FCM_SERVICE_ACCOUNT (JSON), RESEND_API_KEY, EMAIL_FROM
// Schedule it (e.g. every 5 min) with Supabase Cron or an external scheduler.

import { createClient } from 'jsr:@supabase/supabase-js@2';

type Pending = {
  id: string;
  user_id: string;
  title: string;
  message: string;
  task_id: string | null;
  channel: string;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const EMAIL_FROM = Deno.env.get('EMAIL_FROM') ?? 'no-reply@fivelasercut.com';

const db = createClient(SUPABASE_URL, SERVICE_KEY);

// ---- FCM v1 access token -------------------------------------------------
async function fcmAccessToken(): Promise<string | null> {
  const raw = Deno.env.get('FCM_SERVICE_ACCOUNT');
  if (!raw) return null;
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const unsigned = `${b64(header)}.${b64(claim)}`;

  const pem = (sa.private_key as string).replace(/-----[A-Z ]+-----|\n/g, '');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) return null;
  return (await res.json()).access_token ?? null;
}

async function sendPush(tokens: string[], title: string, message: string, taskId: string | null) {
  const token = await fcmAccessToken();
  const projectId = Deno.env.get('FCM_PROJECT_ID');
  if (!token || !projectId || tokens.length === 0) return false;

  const results = await Promise.all(
    tokens.map((t) =>
      fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: t,
            notification: { title, body: message },
            data: { taskId: taskId ?? '' },
            android: { priority: 'HIGH', notification: { channel_id: 'default' } },
          },
        }),
      }).then((r) => r.ok).catch(() => false),
    ),
  );
  return results.some(Boolean);
}

async function sendEmail(to: string, subject: string, body: string) {
  if (!RESEND_API_KEY || !to) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to, subject, text: body }),
  });
  return res.ok;
}

Deno.serve(async (req) => {
  // This function sends real push + email, so it must not be callable by
  // strangers who find the URL. It accepts either:
  //   - Authorization: Bearer <DISPATCH_SECRET>   (used by the cron schedule), or
  //   - Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
  // If DISPATCH_SECRET is not configured, the function refuses to run.
  const secret = Deno.env.get('DISPATCH_SECRET');
  if (!secret) {
    return new Response(JSON.stringify({ error: 'DISPATCH_SECRET not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const bearer = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  if (bearer !== secret && bearer !== SERVICE_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Respect the global email switch.
  const { data: settings } = await db.from('system_settings').select('email_enabled').eq('id', 1).single();
  const emailEnabled = settings?.email_enabled !== false;

  const { data: pending, error } = await db
    .from('notifications')
    .select('id, user_id, title, message, task_id, channel')
    .eq('delivery_status', 'pending')
    .limit(100);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  let sent = 0;
  let failed = 0;

  for (const n of (pending ?? []) as Pending[]) {
    try {
      // Recipient email (for the email channel).
      const { data: profile } = await db
        .from('profiles')
        .select('email')
        .eq('id', n.user_id)
        .single();

      const { data: tokens } = await db
        .from('device_tokens')
        .select('token')
        .eq('user_id', n.user_id)
        .eq('is_active', true);

      const pushOk = await sendPush((tokens ?? []).map((t: any) => t.token), n.title, n.message, n.task_id);
      const emailOk = emailEnabled
        ? await sendEmail(profile?.email ?? '', n.title, n.message)
        : false;

      const ok = pushOk || emailOk;
      await db
        .from('notifications')
        .update({
          delivery_status: ok ? 'sent' : 'failed',
          sent_at: ok ? new Date().toISOString() : null,
          channel: pushOk && emailOk ? 'both' : pushOk ? 'push' : emailOk ? 'email' : n.channel,
        })
        .eq('id', n.id);

      ok ? sent++ : failed++;
    } catch (_e) {
      failed++;
      await db.from('notifications').update({ delivery_status: 'failed' }).eq('id', n.id);
    }
  }

  return new Response(JSON.stringify({ processed: pending?.length ?? 0, sent, failed }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
