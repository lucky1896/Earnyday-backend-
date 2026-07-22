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
app.get('/', (req, res) => res.sendFile('earny-day.html', { root: 'public' }));

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
      referral_code TEXT UNIQUE,
      referred_by INTEGER,
      referral_bonus_paid BOOLEAN NOT NULL DEFAULT FALSE,
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
    CREATE TABLE IF NOT EXISTS offer_completions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      network_trans_id TEXT UNIQUE NOT NULL,
      offer_id TEXT,
      payout_usd NUMERIC NOT NULL,
      coins_awarded INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      icon TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Migration-safe: add new config columns if this table already existed before these were introduced
  await pool.query(`
    ALTER TABLE config ADD COLUMN IF NOT EXISTS cpa_user_share_percent INTEGER NOT NULL DEFAULT 75;
    ALTER TABLE config ADD COLUMN IF NOT EXISTS usd_to_inr_rate NUMERIC NOT NULL DEFAULT 85;
    ALTER TABLE config ADD COLUMN IF NOT EXISTS referral_bonus_coins INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_bonus_paid BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS checkin_streak INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_checkin_date DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_spin_date DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_scratch_date DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_bonus_paid BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS dob DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS badge_bronze_paid BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS badge_silver_paid BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS badge_gold_paid BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS badge_platinum_paid BOOLEAN NOT NULL DEFAULT FALSE;
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
      htmlContent: `
<!DOCTYPE html>
<html>
<body style="margin:0; padding:0; background-color:#f1f3f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f3f6; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px; background-color:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #e3e6ec;">

          <tr>
            <td style="background-color:#0f6b5c; padding:28px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:32px; height:32px; background-color:#ffffff; border-radius:9px; text-align:center; font-size:18px; line-height:32px;">💰</td>
                  <td style="padding-left:12px; color:#ffffff; font-size:20px; font-weight:700; font-family:Arial,sans-serif;">Earny Day</td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:36px 32px 8px;">
              <p style="margin:0 0 6px; font-family:Arial,sans-serif; font-size:22px; font-weight:700; color:#101828;">Verify your email</p>
              <p style="margin:0; font-family:Arial,sans-serif; font-size:14px; color:#667085; line-height:1.6;">
                Enter this code in the app to activate your account. It expires in <b>10 minutes</b>.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f3f6; border-radius:12px;">
                <tr>
                  <td align="center" style="padding:22px 16px;">
                    <span style="font-family:'Courier New',Courier,monospace; font-size:36px; font-weight:700; letter-spacing:10px; color:#0f6b5c;">${otp}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:0 32px 32px;">
              <p style="margin:0; font-family:Arial,sans-serif; font-size:12px; color:#98a2b3; line-height:1.6;">
                Didn't request this? You can safely ignore this email — your account is still secure.
              </p>
            </td>
          </tr>

          <tr>
            <td style="background-color:#f7f8fa; padding:18px 32px; border-top:1px solid #e3e6ec;">
              <p style="margin:0; font-family:Arial,sans-serif; font-size:12px; color:#98a2b3; text-align:center;">Earny Day — Watch. Earn. Daily.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
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
    const { name, email, password, ref } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existingRes = await pool.query('SELECT id, is_verified FROM users WHERE email = $1', [email.toLowerCase()]);
    const existing = existingRes.rows[0];
    if (existing && existing.is_verified) return res.status(409).json({ error: 'Email already registered' });

    // resolve referral code to a referrer's user id, if provided and valid
    let referrerId = null;
    if (ref) {
      const refRes = await pool.query('SELECT id FROM users WHERE referral_code = $1', [ref.toUpperCase()]);
      if (refRes.rows[0]) referrerId = refRes.rows[0].id;
    }

    const hash = bcrypt.hashSync(password, 10);
    let userId;
    if (existing) {
      await pool.query('UPDATE users SET name = $1, password_hash = $2 WHERE id = $3', [name, hash, existing.id]);
      userId = existing.id;
    } else {
      const insertRes = await pool.query(
        'INSERT INTO users (name, email, password_hash, referred_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [name, email.toLowerCase(), hash, referrerId]
      );
      userId = insertRes.rows[0].id;
      // referral_code is derived from the new user's own id — guaranteed unique, no collision handling needed
      const code = 'EARN' + userId.toString(36).toUpperCase();
      await pool.query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, userId]);
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

    // referral bonus — pays out once, only when the referred user successfully verifies
    if (user.referred_by && !user.referral_bonus_paid) {
      const cfg = await getConfig();
      const bonus = cfg.referral_bonus_coins;
      await pool.query('UPDATE users SET wallet_coins = wallet_coins + $1, total_earned = total_earned + $1 WHERE id = $2', [bonus, user.referred_by]);
      await pool.query('UPDATE users SET wallet_coins = wallet_coins + $1, total_earned = total_earned + $1, referral_bonus_paid = TRUE WHERE id = $2', [bonus, user.id]);
      await logActivity(user.referred_by, '🎁', 'Referral bonus earned', `A friend joined using your code · +${bonus} coins`);
      await logActivity(user.id, '🎁', 'Welcome bonus', `Referral signup bonus · +${bonus} coins`);
    }

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

// ---------- REFERRALS ----------
app.get('/api/referral/me', requireAuth, async (req, res) => {
  try {
    const userRes = await pool.query('SELECT referral_code FROM users WHERE id = $1', [req.userId]);
    const referralCode = userRes.rows[0].referral_code;
    const countRes = await pool.query('SELECT COUNT(*) AS c FROM users WHERE referred_by = $1 AND is_verified = TRUE', [req.userId]);
    const cfg = await getConfig();
    res.json({
      referralCode,
      referredCount: parseInt(countRes.rows[0].c, 10),
      bonusPerReferral: cfg.referral_bonus_coins,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load referral info.' });
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

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both current and new password are required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const user = rows[0];
    if (!bcrypt.compareSync(currentPassword, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = bcrypt.hashSync(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not change password.' });
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

// ---------- TASKS (CPA Offerwall — higher-paying tasks like signups, app installs, surveys) ----------
app.get('/api/tasks/wall-url', requireAuth, async (req, res) => {
  if (!process.env.MYLEAD_LOCKER_ID) {
    return res.status(503).json({ error: 'Offerwall not configured yet.' });
  }
  const url = `https://reward-me.eu/${process.env.MYLEAD_LOCKER_ID}?player_id=${req.userId}`;
  res.json({ url });
});

// CPAlead calls this URL automatically (server-to-server) whenever a user completes a task.
// Configure this exact URL as your "Postback URL" in the CPAlead dashboard:
//   https://your-backend-url/api/tasks/postback?subid={subid}&payout={payout}&trans_id={trans_id}&offer_id={offer_id}
app.get('/api/tasks/postback', async (req, res) => {
  try {
    const { subid, payout, trans_id, offer_id } = req.query;
    if (!subid || !payout || !trans_id) return res.status(400).send('Missing parameters');

    const userId = parseInt(subid, 10);
    const payoutUsd = parseFloat(payout);
    if (!userId || isNaN(payoutUsd)) return res.status(400).send('Invalid parameters');

    // idempotency — CPAlead may retry the same postback
    const existing = await pool.query('SELECT id FROM offer_completions WHERE network_trans_id = $1', [trans_id]);
    if (existing.rows.length > 0) return res.send('OK (already processed)');

    const cfg = await getConfig();
    const payoutInr = payoutUsd * cfg.usd_to_inr_rate;
    const userShareInr = payoutInr * (cfg.cpa_user_share_percent / 100);
    let coinsAwarded = Math.round(userShareInr / cfg.coin_to_inr);

    const userRes = await pool.query('SELECT is_premium FROM users WHERE id = $1', [userId]);
    if (userRes.rows[0]?.is_premium) coinsAwarded *= 2;

    await pool.query('INSERT INTO offer_completions (user_id, network_trans_id, offer_id, payout_usd, coins_awarded) VALUES ($1, $2, $3, $4, $5)',
      [userId, trans_id, offer_id || null, payoutUsd, coinsAwarded]);
    await pool.query('UPDATE users SET wallet_coins = wallet_coins + $1, total_earned = total_earned + $1 WHERE id = $2',
      [coinsAwarded, userId]);
    await logActivity(userId, '🎯', 'Task completed', `+${coinsAwarded} coins`);

    res.send('OK');
  } catch (err) {
    console.error('Postback error:', err);
    res.status(500).send('Error');
  }
});

app.get('/api/tasks/history', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT offer_id, coins_awarded, created_at FROM offer_completions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load task history.' });
  }
});

// ---------- EXTRA EARNING FEATURES ----------
const MILESTONES = [
  { key: 'bronze', threshold: 500, coins: 50, column: 'badge_bronze_paid' },
  { key: 'silver', threshold: 2000, coins: 150, column: 'badge_silver_paid' },
  { key: 'gold', threshold: 5000, coins: 400, column: 'badge_gold_paid' },
  { key: 'platinum', threshold: 15000, coins: 1000, column: 'badge_platinum_paid' },
];
const STREAK_REWARDS = [5, 8, 10, 12, 15, 20, 40]; // day 1..7, then cycles
const SPIN_REWARDS = [2, 5, 5, 10, 10, 15, 20, 50];
const SCRATCH_REWARDS = [3, 5, 8, 12, 20, 30];

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function todayStr() { return new Date().toISOString().slice(0, 10); }

async function awardCoins(userId, coins) {
  const { rows } = await pool.query('SELECT is_premium FROM users WHERE id = $1', [userId]);
  const finalCoins = rows[0]?.is_premium ? coins * 2 : coins;
  await pool.query('UPDATE users SET wallet_coins = wallet_coins + $1, total_earned = total_earned + $1 WHERE id = $2', [finalCoins, userId]);
  return finalCoins;
}

async function logActivity(userId, icon, title, subtitle) {
  try {
    await pool.query('INSERT INTO activity_log (user_id, icon, title, subtitle) VALUES ($1, $2, $3, $4)', [userId, icon, title, subtitle || null]);
  } catch (err) { console.error('logActivity failed:', err.message); }
}

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT icon, title, subtitle, created_at FROM activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
      [req.userId]
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load notifications.' }); }
});

app.get('/api/earn/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const u = rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    const today = todayStr();
    const fmt = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
    res.json({
      canCheckin: fmt(u.last_checkin_date) !== today,
      checkinStreak: u.checkin_streak,
      canSpin: fmt(u.last_spin_date) !== today,
      canScratch: fmt(u.last_scratch_date) !== today,
      profileCompleted: !!(u.dob && u.gender),
      profileBonusPaid: u.profile_bonus_paid,
      badges: MILESTONES.map(m => ({ key: m.key, threshold: m.threshold, coins: m.coins, unlocked: u.total_earned >= m.threshold, claimed: u[m.column] })),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load status.' }); }
});

app.post('/api/earn/checkin', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const u = rows[0];
    const today = todayStr();
    const lastDate = u.last_checkin_date ? new Date(u.last_checkin_date).toISOString().slice(0, 10) : null;
    if (lastDate === today) return res.status(400).json({ error: 'Already checked in today.' });

    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const newStreak = lastDate === yesterday ? (u.checkin_streak % 7) + 1 : 1;
    const coins = STREAK_REWARDS[newStreak - 1];

    await pool.query('UPDATE users SET checkin_streak = $1, last_checkin_date = $2 WHERE id = $3', [newStreak, today, u.id]);
    const finalCoins = await awardCoins(u.id, coins);
    await logActivity(u.id, '📅', 'Daily check-in bonus', `Day ${newStreak} streak · +${finalCoins} coins`);
    res.json({ coinsAwarded: finalCoins, streak: newStreak });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Check-in failed.' }); }
});

app.post('/api/earn/spin', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const u = rows[0];
    const today = todayStr();
    const lastDate = u.last_spin_date ? new Date(u.last_spin_date).toISOString().slice(0, 10) : null;
    if (lastDate === today) return res.status(400).json({ error: 'Already spun today.' });

    const coins = pickRandom(SPIN_REWARDS);
    await pool.query('UPDATE users SET last_spin_date = $1 WHERE id = $2', [today, u.id]);
    const finalCoins = await awardCoins(u.id, coins);
    await logActivity(u.id, '🎡', 'Spin & Win reward', `+${finalCoins} coins`);
    res.json({ coinsAwarded: finalCoins });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Spin failed.' }); }
});

app.post('/api/earn/scratch', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const u = rows[0];
    const today = todayStr();
    const lastDate = u.last_scratch_date ? new Date(u.last_scratch_date).toISOString().slice(0, 10) : null;
    if (lastDate === today) return res.status(400).json({ error: 'Already scratched today.' });

    const coins = pickRandom(SCRATCH_REWARDS);
    await pool.query('UPDATE users SET last_scratch_date = $1 WHERE id = $2', [today, u.id]);
    const finalCoins = await awardCoins(u.id, coins);
    await logActivity(u.id, '🎫', 'Scratch card reward', `+${finalCoins} coins`);
    res.json({ coinsAwarded: finalCoins });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Scratch failed.' }); }
});

app.post('/api/earn/complete-profile', requireAuth, async (req, res) => {
  try {
    const { dob, gender } = req.body;
    if (!dob || !gender) return res.status(400).json({ error: 'dob and gender are required' });
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const u = rows[0];
    if (u.profile_bonus_paid) return res.status(400).json({ error: 'Profile bonus already claimed.' });

    const coins = 30;
    await pool.query('UPDATE users SET dob = $1, gender = $2, profile_bonus_paid = TRUE WHERE id = $3', [dob, gender, u.id]);
    const finalCoins = await awardCoins(u.id, coins);
    await logActivity(u.id, '📝', 'Profile completed', `+${finalCoins} coins`);
    res.json({ coinsAwarded: finalCoins });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save profile.' }); }
});

app.post('/api/earn/claim-badge', requireAuth, async (req, res) => {
  try {
    const { key } = req.body;
    const milestone = MILESTONES.find(m => m.key === key);
    if (!milestone) return res.status(400).json({ error: 'Invalid badge.' });

    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const u = rows[0];
    if (u[milestone.column]) return res.status(400).json({ error: 'Badge already claimed.' });
    if (u.total_earned < milestone.threshold) return res.status(400).json({ error: 'Not unlocked yet.' });

    await pool.query(`UPDATE users SET ${milestone.column} = TRUE WHERE id = $1`, [u.id]);
    const finalCoins = await awardCoins(u.id, milestone.coins);
    await logActivity(u.id, '🏅', `${milestone.key} badge unlocked`, `+${finalCoins} coins`);
    res.json({ coinsAwarded: finalCoins });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not claim badge.' }); }
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
      `UPDATE withdrawals SET status = 'paid', paid_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING user_id, amount_inr`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Withdrawal not found or already paid' });
    const w = result.rows[0];
    await logActivity(w.user_id, '✅', 'Withdrawal approved', `₹${w.amount_inr} has been sent`);
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
    const { coin_per_ad, coin_to_inr, min_withdraw_inr, daily_free_limit, user_share_percent, cpa_user_share_percent, usd_to_inr_rate, referral_bonus_coins } = req.body;
    await pool.query(
      `UPDATE config SET
        coin_per_ad = COALESCE($1, coin_per_ad),
        coin_to_inr = COALESCE($2, coin_to_inr),
        min_withdraw_inr = COALESCE($3, min_withdraw_inr),
        daily_free_limit = COALESCE($4, daily_free_limit),
        user_share_percent = COALESCE($5, user_share_percent),
        cpa_user_share_percent = COALESCE($6, cpa_user_share_percent),
        usd_to_inr_rate = COALESCE($7, usd_to_inr_rate),
        referral_bonus_coins = COALESCE($8, referral_bonus_coins)
      WHERE id = 1`,
      [coin_per_ad, coin_to_inr, min_withdraw_inr, daily_free_limit, user_share_percent, cpa_user_share_percent, usd_to_inr_rate, referral_bonus_coins]
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
