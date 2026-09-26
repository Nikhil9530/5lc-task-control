// 5LC Task Control - dispatch-notifications
//
// Reads pending notifications, sends Android PUSH (FCM v1) and EMAIL,
// then records delivery status.
//

import { createClient } from 'jsr:@supabase/supabase-js@2';

type Pending = {
  id: string;
  user_id: string;
  title: string;
  message: string;
  task_id: string | null;
  extension_id: string | null;
  channel: string;
};

type DeviceToken = {
  id: string;
  token: string;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const EMAIL_FROM =
  Deno.env.get('EMAIL_FROM') ?? 'no-reply@fivelasercut.com';

const db = createClient(SUPABASE_URL, SERVICE_KEY);

// -----------------------------------------------------------------------------
// FCM v1 OAuth access token
// -----------------------------------------------------------------------------

async function fcmAccessToken(): Promise<string | null> {
  const raw = Deno.env.get('FCM_SERVICE_ACCOUNT');

  if (!raw) {
    console.error('FCM_SERVICE_ACCOUNT is missing');
    return null;
  }

  try {
    const sa = JSON.parse(raw);

    if (!sa.client_email || !sa.private_key) {
      console.error(
        'FCM_SERVICE_ACCOUNT is invalid: client_email or private_key missing',
      );
      return null;
    }

    const now = Math.floor(Date.now() / 1000);

    const header = {
      alg: 'RS256',
      typ: 'JWT',
    };

    const claim = {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };

    const b64 = (value: unknown) =>
      btoa(JSON.stringify(value))
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

    const unsigned = `${b64(header)}.${b64(claim)}`;

    const pem = (sa.private_key as string)
      .replace(/-----[A-Z ]+-----|\n/g, '');

    const key = await crypto.subtle.importKey(
      'pkcs8',
      Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign'],
    );

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(unsigned),
    );

    const jwt = `${unsigned}.${btoa(
      String.fromCharCode(...new Uint8Array(signature)),
    )
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')}`;

    const response = await fetch(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body:
          `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
      },
    );

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `FCM_OAUTH_HTTP_${response.status}: ${responseText}`,
      );
    }

    const data = JSON.parse(responseText);

    if (!data.access_token) {
      throw new Error(
        `FCM_OAUTH_NO_ACCESS_TOKEN: ${responseText}`,
      );
    }

    return data.access_token;
  } catch (error) {
    const message =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);

    throw new Error(
      `FCM_OAUTH_GENERATION_ERROR: ${message}`,
    );
  }
}

// -----------------------------------------------------------------------------
// FCM PUSH
// -----------------------------------------------------------------------------

async function sendPush(
  tokens: DeviceToken[],
  title: string,
  message: string,
  taskId: string | null,
  notificationId: string,
  extensionId: string | null,
): Promise<boolean> {
  const accessToken = await fcmAccessToken();
  const projectId = Deno.env.get('FCM_PROJECT_ID');

  if (!accessToken) {
    throw new Error(
      'FCM_DIAGNOSTIC: OAuth access token could not be generated',
    );
  }

  if (!projectId) {
    throw new Error(
      'FCM_DIAGNOSTIC: FCM_PROJECT_ID is missing',
    );
  }

  let anySuccess = false;

  for (const device of tokens) {
    try {
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: device.token,

              notification: {
                title,
                body: message,
              },

              data: {
                // Every value must be a string (FCM requirement).
                //
                // notificationId is what lets the app correlate a tapped tray
                // entry with its row in public.notifications, so it can mark the
                // row read and then DISMISS that exact entry. Without it, a
                // tapped notification could never be removed and stayed in the
                // tray for days - the bug this fixes.
                notificationId,
                taskId: taskId ?? '',
                extensionId: extensionId ?? '',
              },

              android: {
                priority: 'HIGH',

                notification: {
                  // Must match the channel created in lib/registerPushToken.ts.
                  // 'default_v2' exists because Android channels are immutable:
                  // the original 'default' channel was created without sound.
                  channel_id: 'default_v2',

                  // Sound + heads-up intent. On Android 8.0+ the CHANNEL owns
                  // the sound (created in lib/registerPushToken.ts with
                  // sound: 'default'); these fields cover older devices and
                  // make the priority/visibility explicit to FCM.
                  // NOTE: 'default_sound' is deliberately NOT sent alongside
                  // 'sound' - the two overlap and a rejected payload would
                  // break delivery entirely.
                  sound: 'default',
                  default_vibrate_timings: true,
                  notification_priority: 'PRIORITY_MAX',
                  visibility: 'PUBLIC',
                },
              },
            },
          }),
        },
      );

      const responseText = await response.text();

      if (!response.ok) {
        console.error('FCM send failed:', {
          status: response.status,
          body: responseText,
          projectId,
          tokenSuffix: device.token.slice(-12),
        });

        // FCM token is permanently invalid.
        // Deactivate only this specific device token and
        // continue sending to the recipient's other devices.
        if (
          response.status === 404 &&
          responseText.includes('UNREGISTERED')
        ) {
          console.warn(
            'Deactivating unregistered FCM token:',
            device.id,
          );

          const { error: deactivateError } = await db
            .from('device_tokens')
            .update({ is_active: false })
            .eq('id', device.id);

          if (deactivateError) {
            console.error(
              'Failed to deactivate unregistered token:',
              deactivateError,
            );
          }

          continue;
        }

        throw new Error(
          `FCM HTTP ${response.status}: ${responseText}`,
        );
      }

      console.log('FCM push sent successfully:', {
        status: response.status,
        tokenSuffix: device.token.slice(-12),
      });

      anySuccess = true;
    } catch (error) {
      console.error('FCM fetch error:', error);
      throw error;
    }
  }

  return anySuccess;
}

// -----------------------------------------------------------------------------
// EMAIL
// -----------------------------------------------------------------------------

async function sendEmail(
  to: string,
  subject: string,
  body: string,
): Promise<boolean> {
  if (!RESEND_API_KEY || !to) {
    return false;
  }

  try {
    const response = await fetch(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },

        body: JSON.stringify({
          from: EMAIL_FROM,
          to,
          subject,
          text: body,
        }),
      },
    );

    const responseText = await response.text();

    if (!response.ok) {
      console.error('Resend email failed:', {
        status: response.status,
        body: responseText,
      });

      return false;
    }

    console.log('Email sent successfully:', {
      status: response.status,
      to,
    });

    return true;
  } catch (error) {
    console.error('Email fetch error:', error);
    return false;
  }
}

// -----------------------------------------------------------------------------
// EDGE FUNCTION
// -----------------------------------------------------------------------------

Deno.serve(async (req) => {
  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  const secret = Deno.env.get('DISPATCH_SECRET');

  if (!secret) {
    console.error(
      'DISPATCH_SECRET is not configured',
    );

    return new Response(
      JSON.stringify({
        error: 'DISPATCH_SECRET not configured',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
  }

  const bearer = (
    req.headers.get('Authorization') ?? ''
  ).replace('Bearer ', '');

  if (
    bearer !== secret &&
    bearer !== SERVICE_KEY
  ) {
    console.error(
      'Unauthorized dispatch-notifications request',
    );

    return new Response(
      JSON.stringify({
        error: 'Unauthorized',
      }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Global email setting
  // ---------------------------------------------------------------------------

  const { data: settings } = await db
    .from('system_settings')
    .select('email_enabled')
    .eq('id', 1)
    .single();

  const emailEnabled =
    settings?.email_enabled !== false;

  // ---------------------------------------------------------------------------
  // Get pending notifications
  // ---------------------------------------------------------------------------

  const {
    data: pending,
    error,
  } = await db
    .from('notifications')
    .select(
      'id, user_id, title, message, task_id, extension_id, channel',
    )
    .eq('delivery_status', 'pending')
    .limit(100);

  if (error) {
    console.error(
      'Failed to fetch pending notifications:',
      error,
    );

    return new Response(
      JSON.stringify({
        error: error.message,
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
  }

  let sent = 0;
  let failed = 0;
  const debugErrors: string[] = [];

  // ---------------------------------------------------------------------------
  // Process notifications
  // ---------------------------------------------------------------------------

  for (const notification of (pending ?? []) as Pending[]) {
    try {
      // -----------------------------------------------------------------------
      // Recipient profile
      // -----------------------------------------------------------------------

      const { data: profile } = await db
        .from('profiles')
        .select('email')
        .eq('id', notification.user_id)
        .single();

      // -----------------------------------------------------------------------
      // Active device tokens
      // -----------------------------------------------------------------------

      const { data: tokens } = await db
        .from('device_tokens')
        .select('id, token')
        .eq('user_id', notification.user_id)
        .eq('is_active', true);

      // -----------------------------------------------------------------------
      // PUSH
      // -----------------------------------------------------------------------

      const pushOk = await sendPush(
        tokens ?? [],
        notification.title,
        notification.message,
        notification.task_id,
        notification.id,
        notification.extension_id,
      );

      // -----------------------------------------------------------------------
      // EMAIL
      // -----------------------------------------------------------------------

      const emailOk = emailEnabled
        ? await sendEmail(
            profile?.email ?? '',
            notification.title,
            notification.message,
          )
        : false;

      // -----------------------------------------------------------------------
      // Final delivery status
      // -----------------------------------------------------------------------

      const ok = pushOk || emailOk;

      const finalChannel =
        pushOk && emailOk
          ? 'both'
          : pushOk
            ? 'push'
            : emailOk
              ? 'email'
              : notification.channel;

      const { error: updateError } = await db
        .from('notifications')
        .update({
          delivery_status: ok
            ? 'sent'
            : 'failed',

          sent_at: ok
            ? new Date().toISOString()
            : null,

          channel: finalChannel,
        })
        .eq('id', notification.id);

      if (updateError) {
        console.error(
          'Failed to update notification status:',
          {
            notificationId: notification.id,
            error: updateError,
          },
        );
      }

      if (ok) {
        sent++;
      } else {
        failed++;

        console.error(
          'Notification delivery failed:',
          {
            notificationId: notification.id,
            userId: notification.user_id,
            pushOk,
            emailOk,
            tokenCount: tokens?.length ?? 0,
          },
        );
      }
    } catch (error) {
      const errorMessage = String(error);

      console.error(
        'Notification processing error:',
        {
          notificationId: notification.id,
          error: errorMessage,
        },
      );

      debugErrors.push(
        `Notification ${notification.id}: ${errorMessage}`,
      );

      failed++;

      const { error: updateError } = await db
        .from('notifications')
        .update({
          delivery_status: 'failed',
        })
        .eq('id', notification.id);

      if (updateError) {
        console.error(
          'Failed to mark notification as failed:',
          updateError,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Response
  // ---------------------------------------------------------------------------

  return new Response(
    JSON.stringify({
      processed: pending?.length ?? 0,
      sent,
      failed,
      debugErrors,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );
});