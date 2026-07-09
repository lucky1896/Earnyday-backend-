// ============================================================
// EARNY DAY — combined single-file backend (Postgres / Supabase version)
// Everything (database, auth, ads, wallet, leaderboard, withdraw,
// payment, admin) lives in this one file so it's easy to copy-paste.
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');
const Razorpay = require('razorpay');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------- DATABASE (Supabase Postgres) ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_verified BOOLEAN NOT NULL DEFAULT FALSE,
      otp_hash TEXT,
      otp_expires_at TIMESTAMPTZ,
      is_premium BOOLEAN NOT NULL DEFAULT FALSE,
      wallet_coins INTEGER NOT NULL DEFAULT 0,
      total_earned INTEGER NOT NULL DEFAULT 0,
      ads_watched_today INTEGER NOT NULL DEFAULT 0,
      last_active_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ad_claims (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      ad_name TEXT NOT NULL,
      coins INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      amount_inr NUMERIC NOT NULL,
      coins_deducted INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      coin_per_ad INTEGER NOT NULL DEFAULT 12,
      coin_to_inr NUMERIC NOT NULL DEFAULT 0.01,
      min_withdraw_inr NUMERIC NOT NULL DEFAULT 50,
      daily_free_limit INTEGER NOT NULL DEFAULT 150,
      user_share_percent INTEGER NOT NULL DEFAULT 80
    );
  `);
  const { rows } = await pool.query('SELECT * FROM config WHERE id = 1');
  if (rows.length === 0) {
    await pool.query('INSERT INTO config (id) VALUES (1)');
  }
}

async function getConfig() {
  const { rows } = await pool.query('SELECT * FROM config WHERE id = 1');
  return rows[0];
}

// ---------- MAILER (uses Brevo's HTTP API over port 443) ----------
async function sendOtpEmail(toEmail, otp) {
  if (!process.env.BREVO_API_KEY || !process.env.SMTP_FROM) {
    console.log(`[DEV — no Brevo API key configured] OTP for ${toEmail}: ${otp}`);
    return;
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Earny Day', email: process.env.SMTP_FROM },
      to: [{ email: toEmail }],
      subject: 'Your Earny Day verification code',
      htmlContent: `<p>Your verification code is <b style="font-size:20px;">${otp}</b>.</p><p>It expires in 10 minutes.</p>`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo API error (${res.status}): ${body}`);
  }
}

// ---------- AUTH HELPERS ----------
function signToken(userId) { return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' }); }
function generateOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.userId = jwt.verify(token, process.env.JWT_SECRET).userId;
    next();
  } catch (err) { return res.status(401).json({ error: 'Invalid or expired token' }); }
}
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) { try { req.userId = jwt.verify(token, process.env.JWT_SECRET).userId; } catch (e) {} }
  next();
}
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key' });
  next();
}

async function issueAndSendOtp(user) {
  const otp = generateOtp();
  const otpHash = bcrypt.hashSync(otp, 8);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await pool.query('UPDATE users SET otp_hash = $1, otp_expires_at = $2 WHERE id = $3', [otpHash, expiresAt, user.id]);
  await sendOtpEmail(user.email, otp);
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- AUTH ROUTES ----------
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existingRes = await pool.query('SELECT id, is_verified FROM users WHERE email = $1', [email.toLowerCase()]);
    const existing = existingRes.rows[0];
    if (existing && existing.is_verified) return res.status(409).json({ error: 'Email already registered' });

    const hash = bcrypt.hashSync(password, 10);
    let userId;
    if (existing) {
      await pool.query('UPDATE users SET name = $1, password_hash = $2 WHERE id = $3', [name, hash, existing.id]);
      userId = existing.id;
    } else {
      const insertRes = await pool.query(
        'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [name, email.toLowerCase(), hash]
      );
      userId = insertRes.rows[0].id;
    }
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    try {
      await issueAndSendOtp(user);
    } catch (err) {
      return res.status(500).json({ error: 'Could not send verification email. Try again shortly.' });
    }
    res.json({ message: 'Verification code sent to your email', email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'email and otp are required' });

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = rows[0];
    if (!user || !user.otp_hash) return res.status(400).json({ error: 'No pending verification for this email' });
    if (new Date(user.otp_expires_at) < new Date()) return res.status(400).json({ error: 'Code expired — request a new one' });
    if (!bcrypt.compareSync(otp, user.otp_hash)) return res.status(400).json({ error: 'Incorrect code' });

    await pool.query('UPDATE users SET is_verified = TRUE, otp_hash = NULL, otp_expires_at = NULL WHERE id = $1', [user.id]);
    res.json({ token: signToken(user.id), user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

app.post('/api/auth/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'No account found for this email' });
    if (user.is_verified) return res.status(400).json({ error: 'Account already verified — please log in' });
    try {
      await issueAndSendOtp(user);
    } catch (err) {
      return res.status(500).json({ error: 'Could not send verification email. Try again shortly.' });
    }
    res.json({ message: 'A new code has been sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not resend code. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.is_verified) return res.status(403).json({ error: 'Please verify your email first', needsVerification: true });
    res.json({ token: signToken(user.id), user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ---------- WALLET ROUTES ----------
app.get('/api/wallet/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, is_premium, wallet_coins, total_earned, ads_watched_today FROM users WHERE id = $1',
      [req.userId]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    const cfg = await getConfig();
    res.json({ ...user, walletInr: +(user.wallet_coins * cfg.coin_to_inr).toFixed(2), minWithdrawInr: +cfg.min_withdraw_inr });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load wallet.' });
  }
});
app.get('/api/wallet/history', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT ad_name, coins, created_at FROM ad_claims WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load history.' });
  }
});

// ---------- ADS ROUTES ----------
const AD_POOL = [
  { name: 'TravelEase — Flight Deals', meta: 'Skippable in 5s · Video' },
  { name: 'ShopKart Summer Sale', meta: 'Banner + Video · 5s' },
  { name: 'QuickLoan App', meta: 'Video · 5s' },
  { name: 'StreamPlay Premium', meta: 'Video · 5s' },
  { name: 'FreshMart Grocery', meta: 'Banner + Video · 5s' },
];
async function resetDailyIfNeeded(user) {
  const today = new Date().toISOString().slice(0, 10);
  const lastActive = user.last_active_date instanceof Date
    ? user.last_active_date.toISOString().slice(0, 10)
    : String(user.last_active_date);
  if (lastActive !== today) {
    await pool.query('UPDATE users SET ads_watched_today = 0, last_active_date = $1 WHERE id = $2', [today, user.id]);
    user.ads_watched_today = 0;
  }
  return user;
}
app.get('/api/ads/queue', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    let user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    user = await resetDailyIfNeeded(user);
    const cfg = await getConfig();
    const atLimit = !user.is_premium && user.ads_watched_today >= cfg.daily_free_limit;
    res.json({ ads: AD_POOL, isPremium: !!user.is_premium, adsWatchedToday: user.ads_watched_today, dailyLimit: cfg.daily_free_limit, atLimit, coinPerAd: cfg.coin_per_ad });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load ads.' });
  }
});
app.post('/api/ads/claim', requireAuth, async (req, res) => {
  try {
    const { adName } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    let user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    user = await resetDailyIfNeeded(user);
    const cfg = await getConfig();
    if (!user.is_premium && user.ads_watched_today >= cfg.daily_free_limit) {
      return res.status(403).json({ error: 'Daily free limit reached', dailyLimit: cfg.daily_free_limit });
    }
    const coins = cfg.coin_per_ad;
    await pool.query(
      'UPDATE users SET wallet_coins = wallet_coins + $1, total_earned = total_earned + $1, ads_watched_today = ads_watched_today + 1 WHERE id = $2',
      [coins, user.id]
    );
    await pool.query('INSERT INTO ad_claims (user_id, ad_name, coins) VALUES ($1, $2, $3)', [user.id, adName || 'Unknown ad', coins]);
    const updatedRes = await pool.query('SELECT wallet_coins, total_earned, ads_watched_today FROM users WHERE id = $1', [user.id]);
    res.json({ coinsAwarded: coins, ...updatedRes.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not claim reward.' });
  }
});

// ---------- LEADERBOARD ----------
app.get('/api/leaderboard/top10', optionalAuth, async (req, res) => {
  try {
    const top10Res = await pool.query('SELECT id, name, total_earned FROM users ORDER BY total_earned DESC LIMIT 10');
    let yourRank = null;
    if (req.userId) {
      const betterRes = await pool.query(
        'SELECT COUNT(*) AS c FROM users WHERE total_earned > (SELECT total_earned FROM users WHERE id = $1)',
        [req.userId]
      );
      yourRank = parseInt(betterRes.rows[0].c, 10) + 1;
    }
    res.json({ top10: top10Res.rows, yourRank });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load leaderboard.' });
  }
});

// ---------- WITHDRAW ----------
app.post('/api/withdraw/request', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    const cfg = await getConfig();
    const availableInr = user.wallet_coins * cfg.coin_to_inr;
    if (availableInr < cfg.min_withdraw_inr) return res.status(400).json({ error: `Minimum withdrawal is ₹${cfg.min_withdraw_inr}`, availableInr });
    const coinsToDeduct = user.wallet_coins;
    const amountInr = +(coinsToDeduct * cfg.coin_to_inr).toFixed(2);
    await pool.query('UPDATE users SET wallet_coins = 0 WHERE id = $1', [user.id]);
    const insertRes = await pool.query(
      'INSERT INTO withdrawals (user_id, amount_inr, coins_deducted) VALUES ($1, $2, $3) RETURNING id',
      [user.id, amountInr, coinsToDeduct]
    );
    res.json({ withdrawalId: insertRes.rows[0].id, amountInr, status: 'pending' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not submit withdrawal request.' });
  }
});
app.get('/api/withdraw/mine', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, amount_inr, status, requested_at, paid_at FROM withdrawals WHERE user_id = $1 ORDER BY requested_at DESC',
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load withdrawals.' });
  }
});

// ---------- PAYMENT (Razorpay Premium purchase) — optional, won't crash server if keys are missing ----------
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
}
const PREMIUM_PRICE_PAISE = 9900;
app.post('/api/payment/create-order', requireAuth, async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Payments are not configured yet. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.' });
  try {
    const order = await razorpay.orders.create({ amount: PREMIUM_PRICE_PAISE, currency: 'INR', receipt: `premium_${req.userId}_${Date.now()}` });
    res.json({ order, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) { res.status(500).json({ error: 'Could not create payment order' }); }
});
app.post('/api/payment/verify', requireAuth, async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Payments are not configured yet.' });
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: 'Missing payment verification fields' });
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ error: 'Payment verification failed' });
    await pool.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [req.userId]);
    res.json({ success: true, isPremium: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not verify payment.' });
  }
});

// ---------- ADMIN ----------
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const cfg = await getConfig();
    const totalsRes = await pool.query('SELECT COALESCE(SUM(total_earned),0) AS totalcoins, COUNT(*) AS totalusers FROM users');
    const totals = totalsRes.rows[0];
    const adsServedRes = await pool.query('SELECT COUNT(*) AS c FROM ad_claims');
    const adsServed = parseInt(adsServedRes.rows[0].c, 10);
    const paidOutRes = await pool.query(`SELECT COALESCE(SUM(amount_inr),0) AS s FROM withdrawals WHERE status = 'paid'`);
    const pendingOutRes = await pool.query(`SELECT COALESCE(SUM(amount_inr),0) AS s FROM withdrawals WHERE status = 'pending'`);
    const userShare = cfg.user_share_percent / 100;
    const platformShare = (1 - userShare) / userShare;
    const userPayoutInr = totals.totalcoins * cfg.coin_to_inr;
    res.json({
      totalUsers: parseInt(totals.totalusers, 10), adsServed,
      userPayoutInr: +userPayoutInr.toFixed(2),
      platformRevenueInr: +(userPayoutInr * platformShare).toFixed(2),
      paidOutInr: +paidOutRes.rows[0].s, pendingWithdrawalsInr: +pendingOutRes.rows[0].s, config: cfg,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load stats.' });
  }
});
app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT w.id, w.amount_inr, w.status, w.requested_at, w.paid_at, u.name, u.email
      FROM withdrawals w JOIN users u ON u.id = w.user_id
      ORDER BY w.requested_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load withdrawals.' });
  }
});
app.post('/api/admin/withdrawals/:id/mark-paid', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE withdrawals SET status = 'paid', paid_at = NOW() WHERE id = $1 AND status = 'pending'`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Withdrawal not found or already paid' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update withdrawal.' });
  }
});
app.get('/api/admin/config', requireAdmin, async (req, res) => {
  res.json(await getConfig());
});
app.post('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const { coin_per_ad, coin_to_inr, min_withdraw_inr, daily_free_limit, user_share_percent } = req.body;
    await pool.query(
      `UPDATE config SET
        coin_per_ad = COALESCE($1, coin_per_ad),
        coin_to_inr = COALESCE($2, coin_to_inr),
        min_withdraw_inr = COALESCE($3, min_withdraw_inr),
        daily_free_limit = COALESCE($4, daily_free_limit),
        user_share_percent = COALESCE($5, user_share_percent)
      WHERE id = 1`,
      [coin_per_ad, coin_to_inr, min_withdraw_inr, daily_free_limit, user_share_percent]
    );
    res.json(await getConfig());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update config.' });
  }
});

const PORT = process.env.PORT || 4000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Earny Day API running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
  });
