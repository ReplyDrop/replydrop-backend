const express = require('express');
const cors    = require('cors');
const https   = require('https');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── ENV VARS (set in Render dashboard) ────────────────────────
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY;
const CLAUDE_KEY       = process.env.CLAUDE_API_KEY;
const STRIPE_SECRET    = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN || 'https://replydrop-site.onrender.com';

// ── CORS ───────────────────────────────────────────────────────
app.use(cors({
  origin: function(origin, callback) {
    // No origin = server-to-server or curl — allow
    if (!origin) return callback(null, true);
    // Chrome extension — always allow
    if (origin.startsWith('chrome-extension://')) return callback(null, true);
    // Allowed web origins
    const allowed = [
      'https://replydrop.ai',
      'https://replydrop-site.onrender.com',
      'https://mail.google.com',
      'https://www.yelp.com',
      'https://www.google.com',
      'https://maps.google.com',
      'https://www.facebook.com',
      'https://outlook.live.com',
      'https://outlook.office.com',
    ];
    if (allowed.includes(origin)) return callback(null, true);
    console.warn('CORS blocked:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Handle preflight requests explicitly
app.options('*', cors());

// ── BODY PARSING ───────────────────────────────────────────────
// Raw body for Stripe webhook signature verification — MUST come before express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
// JSON for everything else
app.use(express.json());

// ── SUPABASE HELPER ────────────────────────────────────────────
function supabase(path, method, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(SUPABASE_URL + path);
    const data   = body ? JSON.stringify(body) : null;
    const opts   = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE}`,
        'apikey':        SUPABASE_SERVICE,
        'Prefer':        'resolution=merge-duplicates,return=representation'
      }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw || '[]') }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── DEBUG ──────────────────────────────────────────────────────
app.get('/debug', (req, res) => {
  res.json({
    supabase_url_set:     !!SUPABASE_URL,
    supabase_url_value:   SUPABASE_URL ? SUPABASE_URL.substring(0, 30) + '...' : 'NOT SET',
    service_key_set:      !!SUPABASE_SERVICE,
    service_key_preview:  SUPABASE_SERVICE ? SUPABASE_SERVICE.substring(0, 20) + '...' : 'NOT SET',
    claude_key_set:       !!CLAUDE_KEY,
    stripe_secret_set:    !!STRIPE_SECRET,
    stripe_webhook_set:   !!STRIPE_WEBHOOK_SECRET,
    allowed_origin:       ALLOWED_ORIGIN
  });
});

// ── HEALTH CHECK ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ReplyDrop backend running ✓', time: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), uptime: Math.floor(process.uptime()) + 's' });
});

// ── KEEP-ALIVE (prevents Supabase free tier pausing after 7 days) ──
const PING_INTERVAL_MS = 4 * 24 * 60 * 60 * 1000; // 4 days
function pingSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE) return;
  const https = require('https');
  const url = new URL(SUPABASE_URL + '/rest/v1/subscribers?select=email&limit=1');
  const req = https.request({
    hostname: url.hostname, path: url.pathname + url.search, method: 'GET',
    headers: { 'apikey': SUPABASE_SERVICE, 'Authorization': 'Bearer ' + SUPABASE_SERVICE }
  }, (res) => { res.resume(); console.log('[KeepAlive] Supabase ping:', res.statusCode); });
  req.on('error', (e) => console.warn('[KeepAlive] Supabase ping failed:', e.message));
  req.end();
}
setTimeout(pingSupabase, 10000);
setInterval(pingSupabase, PING_INTERVAL_MS);

// ── SEND MAGIC LINK ───────────────────────────────────────────
app.post('/send-magic-link', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const body = JSON.stringify({
      email: email.toLowerCase().trim(),
      create_user: true
    });
    const result = await new Promise((resolve, reject) => {
      const urlObj = new URL(SUPABASE_URL + '/auth/v1/otp');
      const opts = {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE,
          'Authorization': `Bearer ${SUPABASE_SERVICE}`,
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const req2 = https.request(opts, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve({ status: r.statusCode, body: d }));
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    console.log('Magic link result:', result.status, result.body);
    if (result.status === 200 || result.status === 204) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Failed to send', detail: result.body });
    }
  } catch(e) {
    console.error('Magic link error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── CHECK PRO STATUS ───────────────────────────────────────────
// FIX: Supabase ilike filter must NOT have the value URL-encoded in the path.
// We build the query string manually to ensure correct format: ilike.value (not ilike.encoded%40value)
app.post('/check-pro', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ isPro: false });

  const cleanEmail = email.toLowerCase().trim();

  try {
    console.log('Checking pro for:', cleanEmail);
    console.log('Supabase URL set:', !!SUPABASE_URL);
    console.log('Service key set:', !!SUPABASE_SERVICE);

    // Build path without encodeURIComponent on the email value — Supabase ilike needs raw dots/@ signs
    const path = `/rest/v1/subscribers?email=ilike.${cleanEmail}&select=is_pro,plan`;
    const result = await supabase(path, 'GET', null);

    console.log('Supabase response status:', result.status);
    console.log('Supabase response data:', JSON.stringify(result.data));

    const row = Array.isArray(result.data) ? result.data[0] : null;
    console.log('Pro check result:', cleanEmail, '→ is_pro:', row?.is_pro);

    return res.json({ isPro: row?.is_pro === true, plan: row?.plan || 'free' });
  } catch (e) {
    console.error('Pro check error:', e);
    return res.json({ isPro: false });
  }
});

// ── JOIN WAITLIST ──────────────────────────────────────────────
app.post('/waitlist', async (req, res) => {
  const { name, email, company, top_feature, price_range } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

  try {
    const result = await supabase('/rest/v1/waitlist', 'POST', {
      name,
      email:       email.toLowerCase().trim(),
      company:     company     || '',
      top_feature: top_feature || '',
      price_range: price_range || ''
    });
    console.log('Waitlist saved:', email, '→ status', result.status);
    res.json({ success: true });
  } catch (e) {
    console.error('Waitlist error:', e);
    res.status(500).json({ error: 'Failed to save' });
  }
});

// ── GENERATE REPLIES (Claude API) ─────────────────────────────
app.post('/generate', async (req, res) => {
  const { message, tone } = req.body;
  if (!message || !tone) return res.status(400).json({ error: 'Missing message or tone' });

  const toneDescriptions = {
    Professional: 'polished, respectful, and business-appropriate',
    Friendly:     'warm, personable, and approachable',
    Firm:         'assertive, direct, and clear about boundaries',
    Apologetic:   'empathetic, understanding, and solution-focused',
    Confident:    'self-assured, composed, and clear'
  };

  const prompt = `You are ReplyDrop, an AI that crafts perfect replies to difficult messages.

The user received this message:
"""
${message}
"""

Generate exactly 3 distinct reply options in a ${tone} tone (${toneDescriptions[tone] || tone}).

Each reply should:
- Be natural and ready to send as-is
- Be 2–5 sentences
- Feel genuinely human, not robotic
- Differ meaningfully from each other

Respond ONLY with a JSON array of exactly 3 strings:
["Reply one.", "Reply two.", "Reply three."]`;

  try {
    const claudeRes = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }]
      });
      const opts = {
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         CLAUDE_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length':    Buffer.byteLength(body)
        }
      };
      const req = https.request(opts, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve(JSON.parse(d)));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const text    = claudeRes.content?.[0]?.text || '';
    const replies = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!Array.isArray(replies) || !replies.length) throw new Error('Invalid response');
    res.json({ replies });
  } catch (e) {
    console.error('Generate error:', e);
    res.status(500).json({ error: 'Failed to generate replies' });
  }
});

// ── STRIPE WEBHOOK ────────────────────────────────────────────
// FIX: Added proper Stripe signature verification using raw body.
// The /webhook route receives raw body (set up above before express.json()).
app.post('/webhook', async (req, res) => {
  // ── Signature verification ──
  if (STRIPE_WEBHOOK_SECRET) {
    const sig = req.headers['stripe-signature'];
    if (!sig) {
      console.error('Missing stripe-signature header');
      return res.status(400).send('Missing signature');
    }
    try {
      // Manual HMAC verification (no stripe npm package required)
      const parts = sig.split(',').reduce((acc, part) => {
        const [k, v] = part.split('=');
        acc[k] = v;
        return acc;
      }, {});
      const timestamp = parts.t;
      const receivedSig = parts.v1;
      const payload = `${timestamp}.${req.body}`;
      const expectedSig = crypto
        .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
        .update(payload, 'utf8')
        .digest('hex');
      if (receivedSig !== expectedSig) {
        console.error('Webhook signature mismatch');
        return res.status(400).send('Invalid signature');
      }
      // Reject webhooks older than 5 minutes to prevent replay attacks
      if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
        console.error('Webhook timestamp too old');
        return res.status(400).send('Timestamp expired');
      }
    } catch (e) {
      console.error('Signature verification error:', e);
      return res.status(400).send('Signature error');
    }
  } else {
    console.warn('⚠️  STRIPE_WEBHOOK_SECRET not set — skipping signature verification');
  }

  // ── Parse event ──
  let event;
  try { event = JSON.parse(req.body); }
  catch (e) { return res.status(400).send('Invalid JSON'); }

  console.log('Stripe event:', event.type);

  // ── Upsert helper ──
  async function upsertSubscriber(email, isPro, plan, stripeId) {
    const payload = {
      email:    email.toLowerCase().trim(),
      is_pro:   isPro,
      plan,
      stripe_id: stripeId,
      updated_at: new Date().toISOString(),
      ...(isPro
        ? { subscribed_at: new Date().toISOString(), cancelled_at: null }
        : { cancelled_at:  new Date().toISOString() })
    };
    const r = await supabase('/rest/v1/subscribers?on_conflict=email', 'POST', payload);
    console.log('Upsert', email, isPro ? '→ PRO ✅' : '→ free ❌', '| HTTP status:', r.status);
    if (r.status >= 400) console.error('Upsert error response:', JSON.stringify(r.data));
    return r;
  }

  // ── Event handling ──
  try {
    switch (event.type) {

      // Payment completed — grant Pro
      case 'checkout.session.completed': {
        const s     = event.data.object;
        const email = s.customer_details?.email || s.customer_email;
        console.log('checkout.session.completed — email:', email, 'customer:', s.customer);
        if (email) await upsertSubscriber(email, true, 'pro', s.customer);
        break;
      }

      // Recurring payment succeeded — keep Pro active
      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        if (inv.customer_email && inv.subscription) {
          console.log('invoice.payment_succeeded — email:', inv.customer_email);
          await upsertSubscriber(inv.customer_email, true, 'pro', inv.customer);
        }
        break;
      }

      // Payment failed — revoke Pro
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        if (inv.customer_email) {
          console.log('invoice.payment_failed — email:', inv.customer_email);
          await upsertSubscriber(inv.customer_email, false, 'free', inv.customer);
        }
        break;
      }

      // Subscription cancelled — revoke Pro
      case 'customer.subscription.deleted': {
        const sub   = event.data.object;
        const email = sub.customer_email || sub.metadata?.email;
        console.log('customer.subscription.deleted — email:', email, 'customer:', sub.customer);
        if (email) await upsertSubscriber(email, false, 'free', sub.customer);
        break;
      }

      default:
        console.log('Unhandled Stripe event type:', event.type);
    }

    res.json({ received: true });
  } catch (e) {
    console.error('Webhook handler error:', e);
    res.status(500).send('Handler failed');
  }
});

// ── START ──────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`ReplyDrop backend running on port ${PORT}`));
