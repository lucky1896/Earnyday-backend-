// ============================================================
// EARNY DAY — combined single-file backend (for easy Replit setup)
// Everything (database, auth, ads, wallet, leaderboard, withdraw,
// payment, admin) lives in this one file so it's easy to copy-paste.
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const Razorpay = require('razorpay');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------- DATABASE ----------
const db = new Database('earnyday.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_verified INTEGER NOT NULL DEFAULT 0,
    otp_hash TEXT,
    otp_expires_at TEXT,
    is_premium INTEGER NOT NULL DEFAULT 0,
    wallet_coins INTEGER NOT NULL DEFAULT 0,
    total_earned INTEGER NOT NULL DEFAULT 0,
    ads_watched_today INTEGER NOT NULL DEFAULT 0,
    last_active_date TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ad_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    ad_name TEXT NOT NULL,
    coins INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount_inr REAL NOT NULL,
    coins_deducted INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at TEXT
  );
  CREATE TABLE IF NOT EXISTS config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    coin_per_ad INTEGER NOT NULL DEFAULT 12,
    coin_to_inr REAL NOT NULL DEFAULT 0.01,
    min_withdraw_inr REAL NOT NULL DEFAULT 50,
    daily_free_limit INTEGER NOT NULL DEFAULT 150,
    user_share_percent INTEGER NOT NULL DEFAULT 80
  );
`);
if (!db.prepare('SELECT * FROM config WHERE id = 1').get()) {
  db.prepare('INSERT INTO config (id) VALUES (1)').run();
}
function getConfig() { return db.prepare('SELECT * FROM config WHERE id = 1').get(); }

// ---------- MAILER (uses Brevo's HTTP API over port 443 — Render's free tier blocks SMTP ports) ----------
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
  db.prepare('UPDATE users SET otp_hash = ?, otp_expires_at = ? WHERE id = ?').run(otpHash, expiresAt, user.id);
  await sendOtpEmail(user.email, otp);
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- AUTH ROUTES ----------
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const existing = db.prepare('SELECT id, is_verified FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing && existing.is_verified) return res.status(409).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(password, 10);
  let userId;
  if (existing) {
    db.prepare('UPDATE users SET name = ?, password_hash = ? WHERE id = ?').run(name, hash, existing.id);
    userId = existing.id;
  } else {
    userId = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name, email.toLowerCase(), hash).lastInsertRowid;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  try {
    await issueAndSendOtp(user);
  } catch (err) {
    return res.status(500).json({ error: 'DEBUG: ' + err.message });
  }
  res.json({ message: 'Verification code sent to your email', email: user.email });
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'email and otp are required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user || !user.otp_hash) return res.status(400).json({ error: 'No pending verification for this email' });
  if (new Date(user.otp_expires_at) < new Date()) return res.status(400).json({ error: 'Code expired — request a new one' });
  if (!bcrypt.compareSync(otp, user.otp_hash)) return res.status(400).json({ error: 'Incorrect code' });
  db.prepare('UPDATE users SET is_verified = 1, otp_hash = NULL, otp_expires_at = NULL WHERE id = ?').run(user.id);
  res.json({ token: signToken(user.id), user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/auth/resend-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) return res.status(404).json({ error: 'No account found for this email' });
  if (user.is_verified) return res.status(400).json({ error: 'Account already verified — please log in' });
  try {
    await issueAndSendOtp(user);
  } catch (err) {
    return res.status(500).json({ error: 'DEBUG: ' + err.message });
  }
  res.json({ message: 'A new code has been sent' });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
  if (!user.is_verified) return res.status(403).json({ error: 'Please verify your email first', needsVerification: true });
  res.json({ token: signToken(user.id), user: { id: user.id, name: user.name, email: user.email } });
});

// ---------- WALLET ROUTES ----------
app.get('/api/wallet/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, is_premium, wallet_coins, total_earned, ads_watched_today FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const cfg = getConfig();
  res.json({ ...user, walletInr: +(user.wallet_coins * cfg.coin_to_inr).toFixed(2), minWithdrawInr: cfg.min_withdraw_inr });
});
app.get('/api/wallet/history', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT ad_name, coins, created_at FROM ad_claims WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.userId));
});

// ---------- ADS ROUTES ----------
const AD_POOL = [
  { name: 'TravelEase — Flight Deals', meta: 'Skippable in 5s · Video' },
  { name: 'ShopKart Summer Sale', meta: 'Banner + Video · 5s' },
  { name: 'QuickLoan App', meta: 'Video · 5s' },
  { name: 'StreamPlay Premium', meta: 'Video · 5s' },
  { name: 'FreshMart Grocery', meta: 'Banner + Video · 5s' },
];
function resetDailyIfNeeded(user) {
  const today = new Date().toISOString().slice(0, 10);
  if (user.last_active_date !== today) {
    db.prepare('UPDATE users SET ads_watched_today = 0, last_active_date = ? WHERE id = ?').run(today, user.id);
    user.ads_watched_today = 0;
  }
  return user;
}
app.get('/api/ads/queue', requireAuth, (req, res) => {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user = resetDailyIfNeeded(user);
  const cfg = getConfig();
  const atLimit = !user.is_premium && user.ads_watched_today >= cfg.daily_free_limit;
  res.json({ ads: AD_POOL, isPremium: !!user.is_premium, adsWatchedToday: user.ads_watched_today, dailyLimit: cfg.daily_free_limit, atLimit, coinPerAd: cfg.coin_per_ad });
});
app.post('/api/ads/claim', requireAuth, (req, res) => {
  const { adName } = req.body;
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user = resetDailyIfNeeded(user);
  const cfg = getConfig();
  if (!user.is_premium && user.ads_watched_today >= cfg.daily_free_limit) {
    return res.status(403).json({ error: 'Daily free limit reached', dailyLimit: cfg.daily_free_limit });
  }
  const coins = cfg.coin_per_ad;
  db.prepare('UPDATE users SET wallet_coins = wallet_coins + ?, total_earned = total_earned + ?, ads_watched_today = ads_watched_today + 1 WHERE id = ?').run(coins, coins, user.id);
  db.prepare('INSERT INTO ad_claims (user_id, ad_name, coins) VALUES (?, ?, ?)').run(user.id, adName || 'Unknown ad', coins);
  const updated = db.prepare('SELECT wallet_coins, total_earned, ads_watched_today FROM users WHERE id = ?').get(user.id);
  res.json({ coinsAwarded: coins, ...updated });
});

// ---------- LEADERBOARD ----------
app.get('/api/leaderboard/top10', optionalAuth, (req, res) => {
  const top10 = db.prepare('SELECT id, name, total_earned FROM users ORDER BY total_earned DESC LIMIT 10').all();
  let yourRank = null;
  if (req.userId) {
    const better = db.prepare('SELECT COUNT(*) as c FROM users WHERE total_earned > (SELECT total_earned FROM users WHERE id = ?)').get(req.userId);
    yourRank = better.c + 1;
  }
  res.json({ top10, yourRank });
});

// ---------- WITHDRAW ----------
app.post('/api/withdraw/request', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const cfg = getConfig();
  const availableInr = user.wallet_coins * cfg.coin_to_inr;
  if (availableInr < cfg.min_withdraw_inr) return res.status(400).json({ error: `Minimum withdrawal is ₹${cfg.min_withdraw_inr}`, availableInr });
  const coinsToDeduct = user.wallet_coins;
  const amountInr = +(coinsToDeduct * cfg.coin_to_inr).toFixed(2);
  db.prepare('UPDATE users SET wallet_coins = 0 WHERE id = ?').run(user.id);
  const info = db.prepare('INSERT INTO withdrawals (user_id, amount_inr, coins_deducted) VALUES (?, ?, ?)').run(user.id, amountInr, coinsToDeduct);
  res.json({ withdrawalId: info.lastInsertRowid, amountInr, status: 'pending' });
});
app.get('/api/withdraw/mine', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, amount_inr, status, requested_at, paid_at FROM withdrawals WHERE user_id = ? ORDER BY requested_at DESC').all(req.userId));
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
app.post('/api/payment/verify', requireAuth, (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Payments are not configured yet.' });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: 'Missing payment verification fields' });
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  if (expected !== razorpay_signature) return res.status(400).json({ error: 'Payment verification failed' });
  db.prepare('UPDATE users SET is_premium = 1 WHERE id = ?').run(req.userId);
  res.json({ success: true, isPremium: true });
});

// ---------- ADMIN ----------
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const cfg = getConfig();
  const totals = db.prepare('SELECT COALESCE(SUM(total_earned),0) as totalCoins, COUNT(*) as totalUsers FROM users').get();
  const adsServed = db.prepare('SELECT COUNT(*) as c FROM ad_claims').get().c;
  const paidOut = db.prepare(`SELECT COALESCE(SUM(amount_inr),0) as s FROM withdrawals WHERE status = 'paid'`).get().s;
  const pendingOut = db.prepare(`SELECT COALESCE(SUM(amount_inr),0) as s FROM withdrawals WHERE status = 'pending'`).get().s;
  const userShare = cfg.user_share_percent / 100;
  const platformShare = (1 - userShare) / userShare;
  const userPayoutInr = totals.totalCoins * cfg.coin_to_inr;
  res.json({
    totalUsers: totals.totalUsers, adsServed,
    userPayoutInr: +userPayoutInr.toFixed(2),
    platformRevenueInr: +(userPayoutInr * platformShare).toFixed(2),
    paidOutInr: paidOut, pendingWithdrawalsInr: pendingOut, config: cfg,
  });
});
app.get('/api/admin/withdrawals', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT w.id, w.amount_inr, w.status, w.requested_at, w.paid_at, u.name, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id ORDER BY w.requested_at DESC`).all());
});
app.post('/api/admin/withdrawals/:id/mark-paid', requireAdmin, (req, res) => {
  const info = db.prepare(`UPDATE withdrawals SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'`).run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Withdrawal not found or already paid' });
  res.json({ success: true });
});
app.get('/api/admin/config', requireAdmin, (req, res) => res.json(getConfig()));
app.post('/api/admin/config', requireAdmin, (req, res) => {
  const { coin_per_ad, coin_to_inr, min_withdraw_inr, daily_free_limit, user_share_percent } = req.body;
  db.prepare(`UPDATE config SET coin_per_ad=COALESCE(?,coin_per_ad), coin_to_inr=COALESCE(?,coin_to_inr), min_withdraw_inr=COALESCE(?,min_withdraw_inr), daily_free_limit=COALESCE(?,daily_free_limit), user_share_percent=COALESCE(?,user_share_percent) WHERE id=1`)
    .run(coin_per_ad, coin_to_inr, min_withdraw_inr, daily_free_limit, user_share_percent);
  res.json(getConfig());
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Earny Day API running on port ${PORT}`));
