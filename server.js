const express = require('express'), http = require('http'), path = require('path'), fs = require('fs');
const cookieParser = require('cookie-parser'), cookie = require('cookie');
const { Server } = require('socket.io');
const Database = require('better-sqlite3'), crypto = require('crypto');

const PROD = process.env.NODE_ENV === 'production';
const VOL = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DATA = process.env.DATA_DIR || VOL || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const PERSISTENT = !onRailway || (!!VOL && path.resolve(DATA).startsWith(path.resolve(VOL)));
if (!PERSISTENT) console.warn('⚠️  WARNING: no Railway Volume attached to the data dir. Data will be LOST on redeploy. Add a Volume mounted at /data.');
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  const f = path.join(DATA, 'secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  SECRET = fs.readFileSync(f, 'utf8').trim();
}
const db = new Database(path.join(DATA, 'messenger.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE NOT NULL,
  name TEXT NOT NULL, country TEXT NOT NULL, number TEXT UNIQUE NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, sender_id INTEGER NOT NULL, receiver_id INTEGER NOT NULL,
  body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_m ON messages(sender_id, receiver_id, id);`);

for (const c of ['banned', 'premium', 'stars', 'stars_spent'])
  if (!db.prepare('PRAGMA table_info(users)').all().some(x => x.name === c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
if (!db.prepare('PRAGMA table_info(users)').all().some(x => x.name === 'pass_hash')) db.exec("ALTER TABLE users ADD COLUMN pass_hash TEXT NOT NULL DEFAULT ''");
if (!db.prepare('PRAGMA table_info(users)').all().some(x => x.name === 'photo')) db.exec("ALTER TABLE users ADD COLUMN photo TEXT NOT NULL DEFAULT ''");
db.exec(`CREATE TABLE IF NOT EXISTS blocks(blocker_id INTEGER NOT NULL, blocked_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(blocker_id, blocked_id));
CREATE TABLE IF NOT EXISTS chat_clear(user_id INTEGER NOT NULL, other_id INTEGER NOT NULL, upto INTEGER NOT NULL, PRIMARY KEY(user_id, other_id));`);
const blockedEither = (a, b) => !!db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(a, b, b, a);
const blockedByMe = (me, other) => !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?').get(me, other);
const clearedUpto = (me, other) => (db.prepare('SELECT upto FROM chat_clear WHERE user_id=? AND other_id=?').get(me, other) || {}).upto || 0;
if (!db.prepare('PRAGMA table_info(users)').all().some(x => x.name === 'bio')) db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
if (!db.prepare('PRAGMA table_info(messages)').all().some(x => x.name === 'gift_id')) db.exec('ALTER TABLE messages ADD COLUMN gift_id INTEGER');
// پیام‌های ویژه (پک استارز / هدیه‌ی پریمیوم): JSON کوچک برای نمایش انیمیشنی در کلاینت
if (!db.prepare('PRAGMA table_info(messages)').all().some(x => x.name === 'special')) db.exec("ALTER TABLE messages ADD COLUMN special TEXT NOT NULL DEFAULT ''");
for (const [c, d] of [['reply_to', 'INTEGER'], ['img', "TEXT NOT NULL DEFAULT ''"]])
  if (!db.prepare('PRAGMA table_info(messages)').all().some(x => x.name === c)) db.exec(`ALTER TABLE messages ADD COLUMN ${c} ${d}`);
db.exec(`CREATE TABLE IF NOT EXISTS gifts(id INTEGER PRIMARY KEY, sender_id INTEGER NOT NULL, receiver_id INTEGER NOT NULL, gift_key TEXT NOT NULL,
  price INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, converted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_g ON gifts(receiver_id, id);`);
for (const c of ['lim_id', 'serial'])
  if (!db.prepare('PRAGMA table_info(gifts)').all().some(x => x.name === c)) db.exec(`ALTER TABLE gifts ADD COLUMN ${c} INTEGER`);
db.exec(`CREATE TABLE IF NOT EXISTS limited_gifts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL, price INTEGER NOT NULL,
  supply INTEGER NOT NULL, sold INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL DEFAULT '#3390ec', active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);`);
for (const [c, d] of [['price_gram', 'REAL'], ['img', "TEXT NOT NULL DEFAULT ''"]])
  if (!db.prepare('PRAGMA table_info(limited_gifts)').all().some(x => x.name === c)) db.exec(`ALTER TABLE limited_gifts ADD COLUMN ${c} ${d}`);

/* ---- ارز «TON» (تون‌کوین واقعی) ----
   نرخ TON (چند ⭐ به‌ازای ۱ TON) = قیمت زنده‌ی تون‌کوین به دلار ÷ ارزش دلاریِ هر ⭐ (متغیر محیطی STAR_USD، پیش‌فرض 0.013).
   قیمت از اینترنت (CoinGecko ← Binance ← Coinbase ← OKX) هر ۶۰ ثانیه گرفته می‌شود؛ اگر هیچ‌کدام جواب ندهند همان نرخ قبلی می‌ماند.
   هدیه‌ی لیمیتدی که قیمتش به TON تعریف شده، قیمت ⭐ = گرد(قیمت TON × نرخ) است؛ با تغییر نرخ، قیمت هدیه هم بالا/پایین می‌شود.
   قیمتی که خریدار لحظه‌ی خرید پرداخته در خودِ هدیه (gifts.price) ثابت می‌ماند. */
db.exec(`CREATE TABLE IF NOT EXISTS app_settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gram_history(id INTEGER PRIMARY KEY, rate REAL NOT NULL, created_at INTEGER NOT NULL);`);   // نام جدول قدیمی است؛ تاریخچه‌ی نرخ TON را نگه می‌دارد
const getSet = (k, d) => { const r = db.prepare('SELECT v FROM app_settings WHERE k=?').get(k); return r ? r.v : d; };
const setSet = (k, v) => db.prepare('INSERT INTO app_settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
const TON_MIN = 0.01, TON_MAX = 1e6, TON_TICK = 60 * 1000, TON_FRESH = 15 * 60 * 1000;
const STAR_USD = parseFloat(process.env.STAR_USD) > 0 ? parseFloat(process.env.STAR_USD) : 0.013;
const r4 = n => Math.round(n * 1e4) / 1e4;
const tonRate = () => { const r = parseFloat(getSet('gram_rate', '100')); return r >= TON_MIN && r <= TON_MAX ? r : 100; };
if (!db.prepare('SELECT 1 FROM gram_history LIMIT 1').get()) db.prepare('INSERT INTO gram_history(rate,created_at) VALUES(?,?)').run(tonRate(), Date.now());
const tonView = () => { const rate = tonRate(), h = db.prepare('SELECT rate FROM gram_history ORDER BY id DESC LIMIT 2').all();
  const prev = h.length > 1 ? h[1].rate : null, updated = +getSet('ton_updated', '0') || 0;
  return { rate, prev, change: prev ? Math.round((rate - prev) / prev * 1e4) / 100 : 0, usd: parseFloat(getSet('ton_usd', '0')) || 0, starUsd: STAR_USD,
    updated, live: Date.now() - updated < TON_FRESH }; };
const setTonRate = rate => { rate = Math.min(TON_MAX, Math.max(TON_MIN, r4(rate))); if (rate === tonRate()) return;
  setSet('gram_rate', rate); db.prepare('INSERT INTO gram_history(rate,created_at) VALUES(?,?)').run(rate, Date.now());
  db.prepare('DELETE FROM gram_history WHERE id <= (SELECT MAX(id) FROM gram_history) - 500').run(); };
const starPrice = L => L.price_gram != null ? Math.max(1, Math.round(L.price_gram * tonRate())) : L.price;
const TON_SRC = [
  ['https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd', j => j['the-open-network'].usd],
  ['https://api.binance.com/api/v3/ticker/price?symbol=TONUSDT', j => j.price],
  ['https://api.coinbase.com/v2/prices/TON-USD/spot', j => j.data.amount],
  ['https://www.okx.com/api/v5/market/ticker?instId=TON-USDT', j => j.data[0].last]];
async function fetchTonUsd() {
  for (const [url, pick] of TON_SRC) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
      if (!r.ok) continue; const v = parseFloat(pick(await r.json()));
      if (Number.isFinite(v) && v > 0 && v < 1e5) return v; } catch (e) { /* منبع بعدی */ }
  }
  return 0; }
let tonBusy = false;
async function tonTick() {
  if (tonBusy) return; tonBusy = true;
  try { const usd = await fetchTonUsd(); if (!usd) return;
    const rate = r4(usd / STAR_USD); if (!(rate >= TON_MIN && rate <= TON_MAX)) return;
    // اولین بار: قیمت ⭐ فعلیِ هدیه‌های «گرامی» حفظ می‌شود و قیمت TON آن‌ها از روی نرخ واقعی بازمحاسبه می‌شود
    if (getSet('ton_migrated_v1', '0') !== '1') db.transaction(() => { const up = db.prepare('UPDATE limited_gifts SET price_gram=? WHERE id=?');
      for (const L of db.prepare('SELECT * FROM limited_gifts WHERE price_gram IS NOT NULL').all()) up.run(r4(starPrice(L) / rate), L.id);
      setSet('ton_migrated_v1', '1'); })();
    setSet('ton_usd', usd); setSet('ton_updated', Date.now()); setTonRate(rate); io.emit('ton', tonView());
  } catch (e) { console.error('ton tick', e.message); } finally { tonBusy = false; } }
setInterval(tonTick, TON_TICK).unref(); setTimeout(tonTick, 1500).unref();
const limView = L => ({ id: L.id, name: L.name, emoji: L.emoji, img: L.img ? mediaUrl(L.img) : '', price: starPrice(L), fixedPrice: L.price,
  priceTon: L.price_gram != null ? L.price_gram : null, supply: L.supply, sold: L.sold, left: L.supply - L.sold, color: L.color, active: !!L.active });

/* ---- NFT «لول بالا» (Elite) ----
   هر NFT لیمیتدی که ارزش فعلی‌اش (gifts.value، بعد از بردن در انفجار) به NFT_ELITE برسد یا از آن بگذرد، «لول بالا» می‌شود
   و طرح ویژه (قاب طلایی درخشان + نشان 👑) می‌گیرد. اگر ارزشش دوباره پایین‌تر از آستانه بیاید، طرح عادی برمی‌گردد. */
const NFT_ELITE = 1000;
/* ۱۰ NFT اولیه با قیمت ۱٬۰۰۰ تا ۱۰٬۰۰۰ ⭐ (قدم ۱٬۰۰۰). قیمتشان بر پایه‌ی «TON» است، پس با نوسان قیمت واقعی تون‌کوین عوض می‌شود. فقط یک‌بار ساخته می‌شوند. */
const ELITE_SEED = [
  ['جغد خرد', '🦉', '#4f8cff', 500], ['گرگ شب', '🐺', '#6b5bd6', 400], ['عقاب طلایی', '🦅', '#e0a526', 300],
  ['ببر آتشین', '🐯', '#e8641c', 250], ['تک‌شاخ', '🦄', '#d65bb4', 200], ['اژدهای زمرد', '🐲', '#1fa971', 150],
  ['کره‌ی جادو', '🔮', '#8a3fd1', 100], ['الماس سیاه', '💎', '#2b2f3a', 75], ['سیاره‌ی حلقه‌دار', '🪐', '#0f8fb5', 50],
  ['تاج شاهنشاه', '👑', '#c8921a', 25]];
if (getSet('seed_elite_nfts_v1', '0') !== '1') {
  db.transaction(() => { const ins = db.prepare('INSERT INTO limited_gifts(name,emoji,price,supply,color,created_at,price_gram,img) VALUES(?,?,?,?,?,?,?,?)');
    ELITE_SEED.forEach(([name, emoji, color, supply], i) => { const target = (i + 1) * 1000;
      ins.run(name, emoji, target, supply, color, Date.now(), r4(target / tonRate()), ''); });
    setSet('seed_elite_nfts_v1', '1'); })();
}

/* ---- ویژگی‌های کلکسیونی هدیه‌ی لیمیتد (مدل / نماد / پس‌زمینه) ----
   p = شانس به‌هزارم (جمع هر لیست = ۱۰۰۰؛ مثلاً ۳۰ = ۳٪). با هر خرید، سه ویژگی به‌صورت تصادفیِ وزن‌دار
   برای همان نسخه قرعه‌کشی و ثابت ذخیره می‌شود. فقط به انتهای لیست‌ها اضافه کنید (ترتیب/شناسه‌ها را عوض نکنید). */
const TR_MODELS = [
  { id: 'classic', name: 'کلاسیک', p: 400, hue: 0, sat: 1 }, { id: 'ice', name: 'یخی', p: 250, hue: 165, sat: 1.1 },
  { id: 'fire', name: 'آتشین', p: 180, hue: -35, sat: 1.3 }, { id: 'forest', name: 'جنگلی', p: 100, hue: 90, sat: 1.1 },
  { id: 'violet', name: 'بنفش', p: 50, hue: 250, sat: 1.2 }, { id: 'gold', name: 'طلایی', p: 20, hue: 35, sat: 1.9 }];
const TR_SYMBOLS = [
  { id: 'spark', name: 'جرقه', emoji: '✨', p: 300 }, { id: 'moon', name: 'ماه', emoji: '🌙', p: 250 },
  { id: 'eagle', name: 'عقاب', emoji: '🦅', p: 200 }, { id: 'blossom', name: 'شکوفه', emoji: '🌸', p: 130 },
  { id: 'bolt', name: 'آذرخش', emoji: '⚡', p: 70 }, { id: 'crown', name: 'تاج', emoji: '👑', p: 30 },
  { id: 'dragon', name: 'اژدها', emoji: '🐉', p: 15 }, { id: 'galaxy', name: 'کهکشان', emoji: '🪐', p: 5 }];
const TR_BACKDROPS = [
  { id: 'azure', name: 'آبی آسمانی', c1: '#4fb0d9', c2: '#1f6f96', p: 250 }, { id: 'emerald', name: 'سبز زمردی', c1: '#3fbf8a', c2: '#146c4a', p: 200 },
  { id: 'night', name: 'بنفش شب', c1: '#8a63d2', c2: '#3b2478', p: 180 }, { id: 'sunset', name: 'نارنجی غروب', c1: '#f0894a', c2: '#a13f14', p: 150 },
  { id: 'ruby', name: 'قرمز یاقوتی', c1: '#e0505f', c2: '#7d1526', p: 100 }, { id: 'steel', name: 'خاکستری فولادی', c1: '#8e9aa6', c2: '#46525d', p: 60 },
  { id: 'rose', name: 'صورتی', c1: '#ec7fb0', c2: '#9a3466', p: 40 }, { id: 'onyx', name: 'سیاه اونیکس', c1: '#4a4f57', c2: '#0d0f12', p: 15 },
  { id: 'aurum', name: 'طلایی', c1: '#f2c14e', c2: '#9a6a10', p: 5 }];
const pickW = pool => { let r = crypto.randomInt(1000); for (const x of pool) { r -= x.p; if (r < 0) return x.id; } return pool[0].id; };
const rollTraits = () => ({ m: pickW(TR_MODELS), s: pickW(TR_SYMBOLS), b: pickW(TR_BACKDROPS) });
const traitsView = raw => { let t; try { t = JSON.parse(raw || ''); } catch { return null; }
  const m = TR_MODELS.find(x => x.id === t.m), s = TR_SYMBOLS.find(x => x.id === t.s), b = TR_BACKDROPS.find(x => x.id === t.b);
  if (!m || !s || !b) return null;
  return { model: { name: m.name, pct: m.p / 10, hue: m.hue, sat: m.sat }, symbol: { name: s.name, emoji: s.emoji, pct: s.p / 10 },
    backdrop: { name: b.name, c1: b.c1, c2: b.c2, pct: b.p / 10 } }; };
if (!db.prepare('PRAGMA table_info(gifts)').all().some(x => x.name === 'traits')) db.exec('ALTER TABLE gifts ADD COLUMN traits TEXT');
// هدیه‌های لیمیتدی که قبل از این قابلیت فروخته شده‌اند، یک‌بار ویژگی می‌گیرند
db.transaction(() => { const up = db.prepare('UPDATE gifts SET traits=? WHERE id=?');
  for (const r of db.prepare('SELECT id FROM gifts WHERE lim_id IS NOT NULL AND traits IS NULL').all()) up.run(JSON.stringify(rollTraits()), r.id); })();
// ارزش فعلی NFT (بعد از بردن در بازی انفجار بالا می‌رود؛ null یعنی همان قیمت خرید) و قفل «در حال بازی»
for (const [c, d] of [['value', 'INTEGER'], ['staked', 'INTEGER NOT NULL DEFAULT 0'], ['listed', 'INTEGER NOT NULL DEFAULT 0']])
  if (!db.prepare('PRAGMA table_info(gifts)').all().some(x => x.name === c)) db.exec(`ALTER TABLE gifts ADD COLUMN ${c} ${d}`);
const valueOf = g => g.value != null ? g.value : g.price;
const GIFTS = [
  { key: 'bear', emoji: '🧸', name: 'خرس', price: 15 }, { key: 'heart', emoji: '💝', name: 'قلب', price: 15 },
  { key: 'box', emoji: '🎁', name: 'هدیه', price: 25 }, { key: 'rose', emoji: '🌹', name: 'رز', price: 25 },
  { key: 'cake', emoji: '🎂', name: 'کیک', price: 50 }, { key: 'flowers', emoji: '💐', name: 'دسته‌گل', price: 50 },
  { key: 'rocket', emoji: '🚀', name: 'موشک', price: 50 }, { key: 'trophy', emoji: '🏆', name: 'جام', price: 100 },
  { key: 'ring', emoji: '💍', name: 'انگشتر', price: 100 }, { key: 'diamond', emoji: '💎', name: 'الماس', price: 100 }];
const refundOf = price => Math.floor(price * 0.85);
/* ---- رتبه‌ی پروفایل (لول) — مثل Star Rating تلگرام ----
   امتیاز = ۱۰۰٪ ⭐ هدیه‌هایی که می‌خرید/می‌فرستید + ۲۰٪ ⭐ ری‌اکشن‌های ⭐ زیر پست.
   اگر هدیه‌ای که فرستاده‌اید توسط گیرنده به ⭐ تبدیل شود، ۸۵٪ قیمتش از امتیاز شما کم می‌شود.
   آستانه‌ی لول‌های ۱ تا ۱۶ دقیقاً مثل تلگرام است؛ از ۱۷ به بعد تقریباً ۱۳٬۰۰۰ امتیاز برای هر لول (تا ۱۰۰). */
const RATING_STEPS = [1, 5000, 12000, 19000, 27000, 36000, 46000, 57000, 68000, 81000, 94000, 107000, 120000, 133000, 146000, 160000];
while (RATING_STEPS.length < 100) RATING_STEPS.push(RATING_STEPS[RATING_STEPS.length - 1] + 13000);
const RATING_PER_STAR_REACTION = 0.2;
const ratingView = raw => { const pts = Math.round((raw || 0) * 100) / 100, lv = RATING_STEPS.filter(t => pts >= t).length;
  return { level: lv, pts: Math.floor(pts), cur: lv ? RATING_STEPS[lv - 1] : 0, next: RATING_STEPS[lv] || null }; };
const ratingOf = id => { const r = ratingView((db.prepare('SELECT rating r FROM users WHERE id=?').get(id) || {}).r); return { level: r.level, rating: r }; };
const giftView = g => { let c = GIFTS.find(x => x.key === g.gift_key) || {}, limited = null;
  if (g.lim_id) { const L = db.prepare('SELECT * FROM limited_gifts WHERE id=?').get(g.lim_id);
    if (L) { c = L; limited = { id: L.id, serial: g.serial, supply: L.supply, sold: L.sold, color: L.color, traits: traitsView(g.traits),
      img: L.img ? mediaUrl(L.img) : '', nowPrice: starPrice(L), tonPriced: L.price_gram != null }; } }
  return { id: g.id, key: g.gift_key, limited, img: limited ? limited.img : '', emoji: c.emoji || '🎁', name: c.name || 'هدیه', price: g.price, value: valueOf(g), staked: !!g.staked, listed: !!g.listed, elite: !!g.lim_id && valueOf(g) >= NFT_ELITE, refund: refundOf(valueOf(g)),
    note: g.note, converted: !!g.converted, hidden: !!g.hidden, at: g.created_at, from: g.sender_id, to: g.receiver_id,
    owner: db.prepare('SELECT id,name,username FROM users WHERE id=?').get(g.receiver_id) || { id: 0, name: '—', username: '' } }; };
if (!db.prepare('PRAGMA table_info(users)').all().some(x => x.name === 'premium_until')) db.exec('ALTER TABLE users ADD COLUMN premium_until INTEGER NOT NULL DEFAULT 0');
for (const c of ['emoji_status', 'name_color', 'profile_color'])
  if (!db.prepare('PRAGMA table_info(users)').all().some(x => x.name === c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`);
if (!db.prepare('PRAGMA table_info(users)').all().some(x => x.name === 'profile_gift')) db.exec('ALTER TABLE users ADD COLUMN profile_gift INTEGER NOT NULL DEFAULT 0');
if (!db.prepare('PRAGMA table_info(users)').all().some(x => x.name === 'admin_tag')) db.exec("ALTER TABLE users ADD COLUMN admin_tag TEXT NOT NULL DEFAULT ''");
const USER_TAGS = { owner: 'Owner', admin: 'Admin', scam: 'Scam', fake: 'جعلی' };
const isPrem = u => !!u.premium || (u.premium_until || 0) > Date.now();
const LIM = u => isPrem(u) ? { bio: 140, channels: 20, msg: 8000 } : { bio: 70, channels: 10, msg: 4000 };
const PREMIUM_PLANS = { '1m': { months: 1, price: 100 }, '3m': { months: 3, price: 250 }, '12m': { months: 12, price: 800 } };
// پک‌های استارز (قابل هدیه دادن): ⭐ از موجودی فرستنده کم و ۱ به ۱ به گیرنده اضافه می‌شود.
// c1/c2 رنگ گرادیان انیمیشن پک هستند. برای افزودن پک جدید یک ردیف اضافه کنید.
const STAR_PACKS = [
  { id: 'p50',   stars: 50,   name: 'جرقه',     c1: '#ffd54a', c2: '#ff9f1c' },
  { id: 'p100',  stars: 100,  name: 'برنزی',    c1: '#f0a35e', c2: '#c8651b' },
  { id: 'p250',  stars: 250,  name: 'نقره‌ای',   c1: '#cfe3f7', c2: '#6f9bd1' },
  { id: 'p500',  stars: 500,  name: 'طلایی',    c1: '#ffe066', c2: '#f59f00' },
  { id: 'p1000', stars: 1000, name: 'یاقوتی',   c1: '#ff6b8a', c2: '#c2185b' },
  { id: 'p2500', stars: 2500, name: 'کیهانی',   c1: '#8b7bff', c2: '#2dd4ff' },
];
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const h = x => crypto.createHash('sha256').update(String(x)).digest();
const isAdminPw = x => !!ADMIN_PASSWORD && crypto.timingSafeEqual(h(x), h(ADMIN_PASSWORD));
const hashPw = pw => { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); };
const checkPw = (pw, stored) => { const [s, k] = String(stored || '').split(':'); if (!s || !k) return false;
  const a = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64), b = Buffer.from(k, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const COUNTRIES = { IR: '+98', AZ: '+994', TR: '+90' };
const online = new Map();
// هدیه‌ی لیمیتدی که کاربر پریمیوم کنار عکس پروفایلش گذاشته (مثل NFT/کالکتیبل تلگرام)؛ اگر پریمیوم تمام شود یا هدیه تبدیل شود، خودکار مخفی می‌شود
const wearView = u => { if (!u.profile_gift || !isPrem(u)) return null;
  const g = db.prepare('SELECT * FROM gifts WHERE id=? AND receiver_id=? AND channel_id IS NULL AND converted=0 AND lim_id IS NOT NULL').get(u.profile_gift, u.id);
  if (!g) return null;
  return { ...giftView(g), sender: db.prepare('SELECT id,name,username FROM users WHERE id=?').get(g.sender_id) || { id: 0, name: '—', username: '' } }; };
const pub = u => ({ tag: USER_TAGS[u.admin_tag] ? u.admin_tag : '', tagLabel: USER_TAGS[u.admin_tag] || '', wear: wearView(u),  id: u.id, username: u.username, name: u.name, country: u.country, premium: isPrem(u), emojiStatus: isPrem(u) ? u.emoji_status || '' : '', nameColor: isPrem(u) ? u.name_color || '' : '', profileColor: isPrem(u) ? u.profile_color || '' : '', bio: u.bio || '', photo: mediaUrl(u.photo), level: ratingView(u.rating).level, rating: ratingView(u.rating), lastSeen: u.last_seen, online: online.has(u.id) });
const mine = u => ({ ...pub(u), number: u.pass_hash ? '' : u.number, stars: u.stars, premiumUntil: u.premium_until || 0, permanent: !!u.premium, limits: LIM(u), rawEmoji: u.emoji_status || '', rawNameColor: u.name_color || '', rawProfileColor: u.profile_color || '', rawWear: u.profile_gift || 0 });
// پیش‌نمایش پیامی که به آن ریپلای شده؛ و اعتبارسنجی اینکه پیام مقصد در همین گفتگو باشد
const replyView = id => { if (!id) return null; const r = db.prepare('SELECT id,sender_id,body,img,gift_id FROM messages WHERE id=?').get(id);
  return r ? { id: r.id, from: r.sender_id, body: r.gift_id ? '🎁 هدیه' : String(r.body || '').slice(0, 120), photo: !!r.img } : null; };
const okReply = (id, a, b) => { id = +id; return id && db.prepare('SELECT 1 FROM messages WHERE id=? AND ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?))').get(id, a, b, b, a) ? id : null; };
const specialOf = raw => { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } };
const fmt = m => ({ id: m.id, from: m.sender_id, to: m.receiver_id, body: m.body, at: m.created_at, read: !!m.read_at, special: specialOf(m.special),
  img: mediaUrl(m.img), rx: rxList('d', m.id), reply: replyView(m.reply_to),
  gift: m.gift_id ? (g => g && giftView(g))(db.prepare('SELECT * FROM gifts WHERE id=?').get(m.gift_id)) : null });
const normNum = s => { s = String(s || '').replace(/\s/g, ''); return s.startsWith('+') ? s : '+' + s; };

const app = express(), server = http.createServer(app), io = new Server(server);
app.set('trust proxy', 1);
const jsonSmall = express.json({ limit: '10kb' }), jsonBig = express.json({ limit: '1mb' });
app.use((req, res, next) => ((/^\/api\/channels(\/\d+(\/posts|\/emojis)?)?$/.test(req.path) || req.path === '/api/me' || req.path === '/api/admin/pemojis' || /^\/api\/messages\/\d+\/photo$/.test(req.path)) ? jsonBig : jsonSmall)(req, res, next), cookieParser(SECRET));
app.use('/media', express.static(MEDIA, { maxAge: '30d', immutable: true, setHeaders: r => r.setHeader('X-Content-Type-Options', 'nosniff') }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.send('ok'));

const hits = new Map();
const limit = max => (req, res, next) => {
  const k = req.ip + req.path, n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < 600000);
  a.push(n); hits.set(k, a);
  a.length > max ? res.status(429).json({ error: 'تلاش زیاد؛ چند دقیقه بعد دوباره امتحان کنید' }) : next();
};
const setSession = (res, id, remember = true) => res.cookie('uid', String(id), { signed: true, httpOnly: true, sameSite: 'lax', secure: PROD, ...(remember ? { maxAge: 3.15e10 } : {}) });
const auth = (req, res, next) => {
  const id = +req.signedCookies.uid;
  const u = id && db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  if (u.banned) return res.status(403).json({ error: 'banned' });
  req.user = u; next();
};

app.post('/api/signup', limit(20), (req, res) => {
  const username = String(req.body.username || '').trim();
  const name = String(req.body.name || '').trim().slice(0, 40) || username;
  const password = String(req.body.password || '');
  if (!/^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(username)) return res.status(400).json({ error: 'نام کاربری باید ۳ تا ۲۰ حرف انگلیسی/عدد/_ باشد و با حرف شروع شود' });
  if (password.length < 6 || password.length > 100) return res.status(400).json({ error: 'رمز ورود باید حداقل ۶ کاراکتر باشد' });
  try {
    // ستون number در دیتابیس قدیمی NOT NULL UNIQUE است؛ کاربران جدید فقط یک مقدار داخلی یکتا می‌گیرند و به کاربر نشان داده نمی‌شود
    const r = db.prepare('INSERT INTO users(username,name,country,number,last_seen,pass_hash) VALUES(?,?,?,?,?,?)')
      .run(username, name, '', 'pw:' + crypto.randomBytes(9).toString('hex'), Date.now(), hashPw(password));
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    setSession(res, u.id); res.json({ me: mine(u) });
  } catch (e) { res.status(409).json({ error: 'این نام کاربری قبلاً گرفته شده' }); }
});

app.post('/api/login', limit(20), (req, res) => {
  if (isAdminPw(req.body.password ?? req.body.number)) {
    res.cookie('adm', '1', { signed: true, httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 4.32e7 });
    return res.json({ admin: true });
  }
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(req.body.username || '').trim().replace(/^@/, ''));
  const secret = req.body.password ?? req.body.number;
  const ok = u && (u.pass_hash ? checkPw(secret, u.pass_hash) : u.number === normNum(secret));
  if (!ok) return res.status(401).json({ error: 'نام کاربری یا رمز اشتباه است' });
  if (u.banned) return res.status(403).json({ error: 'حساب شما مسدود شده است' });
  setSession(res, u.id, req.body.remember !== 'off'); res.json({ me: mine(u) });
});
app.post('/api/logout', (_, res) => { res.clearCookie('uid'); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ me: mine(req.user) }));

app.post('/api/me/password', auth, limit(10), (req, res) => {
  const u = req.user, cur = String(req.body.current || ''), pw = String(req.body.password || '');
  if (pw.length < 6 || pw.length > 100) return res.status(400).json({ error: 'رمز جدید باید حداقل ۶ کاراکتر باشد' });
  const ok = u.pass_hash ? checkPw(cur, u.pass_hash) : u.number === normNum(cur);
  if (!ok) return res.status(403).json({ error: u.pass_hash ? 'رمز فعلی اشتباه است' : 'شماره‌ی فعلی اشتباه است' });
  // با تنظیم رمز، شماره‌ی قدیمی از دیتابیس حذف می‌شود (ستون number همچنان NOT NULL UNIQUE است، پس یک مقدار داخلی جایگزین می‌شود)
  db.prepare('UPDATE users SET pass_hash=?, number=? WHERE id=?').run(hashPw(pw), u.pass_hash ? u.number : 'pw:' + crypto.randomBytes(9).toString('hex'), u.id);
  res.json({ me: mine(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)) });
});
app.patch('/api/me', auth, (req, res) => {
  const u = req.user, lim = LIM(u), b = req.body || {};
  const name = String(b.name ?? u.name).trim().slice(0, 40), bio = String(b.bio ?? u.bio).trim().slice(0, lim.bio);
  if (!name) return res.status(400).json({ error: 'نام نمی‌تواند خالی باشد' });
  let emoji = u.emoji_status, nc = u.name_color, pc = u.profile_color;
  const has = k => Object.prototype.hasOwnProperty.call(b, k);
  if (has('emojiStatus') || has('nameColor') || has('profileColor')) {
    const ne = has('emojiStatus') ? String(b.emojiStatus || '').trim() : emoji, nn = has('nameColor') ? String(b.nameColor || '') : nc, np = has('profileColor') ? String(b.profileColor || '') : pc;
    if (!isPrem(u) && (ne !== emoji || nn !== nc || np !== pc) && (ne || nn || np)) return res.status(403).json({ error: 'این امکانات ویژه‌ی کاربران پریمیوم است' });
    if (ne && !/^[^\w\s<>&"']{1,12}$/u.test(ne)) return res.status(400).json({ error: 'ایموجی استاتوس نامعتبر است' });
    if ((nn && !/^#[0-9a-fA-F]{6}$/.test(nn)) || (np && !/^#[0-9a-fA-F]{6}$/.test(np))) return res.status(400).json({ error: 'رنگ نامعتبر است' });
    emoji = ne; nc = nn; pc = np;
  }
  let wg = u.profile_gift || 0;
  if (has('wearGift')) { const id = +b.wearGift || 0;
    if (id) {
      if (!isPrem(u)) return res.status(403).json({ error: 'این امکان ویژه‌ی کاربران پریمیوم است' });
      if (!db.prepare('SELECT 1 FROM gifts WHERE id=? AND receiver_id=? AND channel_id IS NULL AND converted=0 AND listed=0 AND lim_id IS NOT NULL').get(id, u.id))
        return res.status(400).json({ error: 'فقط هدیه‌ی لیمیتدِ خودتان را می‌توانید روی پروفایل بگذارید' });
    }
    wg = id; }
  let photo = u.photo || '';
  if (b.removePhoto) photo = '';
  else if (b.photo) {
    photo = saveImage(b.photo, `u-${u.id}-${Date.now()}.jpg`, 200e3);
    if (!photo) return res.status(400).json({ error: 'تصویر نامعتبر یا حجیم است' });
  }
  if (photo !== (u.photo || '')) rmMedia(u.photo);
  db.prepare('UPDATE users SET name=?, bio=?, emoji_status=?, name_color=?, profile_color=?, photo=?, profile_gift=? WHERE id=?').run(name, bio, emoji, nc, pc, photo, wg, u.id);
  res.json({ me: mine(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)) });
});
app.get('/api/users/:id', auth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=? AND banned=0').get(+req.params.id);
  u ? res.json({ user: { ...pub(u), blockedByMe: blockedByMe(req.user.id, u.id) } }) : res.status(404).json({ error: 'کاربر پیدا نشد' });
});
app.get('/api/search', auth, (req, res) => {
  const q = String(req.query.q || '').trim().replace(/^@/, '').replace(/[\\%_]/g, '\\$&');
  if (!q) return res.json({ users: [], channels: [] });
  const rows = db.prepare(`SELECT * FROM users WHERE username LIKE ? ESCAPE '\\' AND id != ? AND banned = 0
    ORDER BY (username LIKE ? ESCAPE '\\') DESC, username LIMIT 20`).all(`%${q}%`, req.user.id, `${q}%`);
  const chs = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM channel_subs WHERE channel_id=c.id) subs FROM channels c
    WHERE handle LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' ORDER BY (handle LIKE ? ESCAPE '\\') DESC LIMIT 20`).all(`%${q}%`, `%${q}%`, `${q}%`)
    .map(c => ({ id: c.id, title: c.title, handle: c.handle, subs: c.subs, photo: mediaUrl(c.photo), pinned: !!c.pinned, sponsored: !!c.sponsored, ...chLook(c) }));
  chs.sort((x, y) => (+y.sponsored - +x.sponsored) || ((y.level >= 5) - (x.level >= 5)));
  res.json({ users: rows.map(pub), channels: chs });
});

app.get('/api/chats', auth, (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`SELECT u.*, m.body b, m.img mi, m.created_at mt, m.sender_id ms, m.read_at mr,
    (SELECT COUNT(*) FROM messages WHERE sender_id=u.id AND receiver_id=@me AND read_at IS NULL) unread
    FROM users u JOIN messages m ON m.id=(SELECT MAX(id) FROM messages WHERE ((sender_id=@me AND receiver_id=u.id) OR (sender_id=u.id AND receiver_id=@me)) AND id NOT IN (SELECT msg_id FROM msg_hidden WHERE user_id=@me))
    WHERE u.id IN (SELECT receiver_id FROM messages WHERE sender_id=@me UNION SELECT sender_id FROM messages WHERE receiver_id=@me)
    AND m.id > COALESCE((SELECT upto FROM chat_clear WHERE user_id=@me AND other_id=u.id), 0)
    ORDER BY m.id DESC`).all({ me });
  res.json({ chats: rows.map(r => ({ user: pub(r), unread: r.unread, last: { body: r.b, photo: !!r.mi, at: r.mt, from: r.ms, read: !!r.mr } })) });
});

app.get('/api/messages/:id', auth, (req, res) => {
  const me = req.user.id, other = +req.params.id, before = +req.query.before || 9e15;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(other);
  if (!u) return res.status(404).json({ error: 'not found' });
  const rows = db.prepare(`SELECT * FROM messages WHERE id < ? AND id > ? AND ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?))
    AND id NOT IN (SELECT msg_id FROM msg_hidden WHERE user_id=${me}) ORDER BY id DESC LIMIT 60`).all(before, clearedUpto(me, other), me, other, other, me).reverse();
  res.json({ user: { ...pub(u), blockedByMe: blockedByMe(me, other) }, messages: rows.map(fmt) });
});

/* ---- پیام تصویری در چت (عکس + توضیح اختیاری + ریپلای اختیاری) ---- */
app.post('/api/messages/:id/photo', auth, limit(60), (req, res) => {
  const me = req.user.id, to = +req.params.id;
  if (!to || to === me || !db.prepare('SELECT 1 FROM users WHERE id=? AND banned=0').get(to)) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  if (blockedEither(me, to)) return res.status(403).json({ error: blockedByMe(me, to) ? 'این کاربر را بلاک کرده‌اید؛ ابتدا رفع بلاک کنید' : 'امکان ارسال پیام به این کاربر وجود ندارد' });
  const body = stripPe(req.user, String(req.body.body || '').trim().slice(0, Math.min(1024, LIM(req.user).msg))).trim();
  const file = saveImage(req.body.photo, `m-${me}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`, 700e3);
  if (!file) return res.status(400).json({ error: 'تصویر نامعتبر یا حجیم است' });
  const rp = okReply(req.body.replyTo, me, to);
  const r = db.prepare('INSERT INTO messages(sender_id,receiver_id,body,created_at,img,reply_to) VALUES(?,?,?,?,?,?)').run(me, to, body, Date.now(), file, rp);
  io.to('u:' + me).to('u:' + to).emit('message', fmt(db.prepare('SELECT * FROM messages WHERE id=?').get(r.lastInsertRowid)));
  res.json({ ok: true });
});

/* ---- بلاک و حذف گفتگو ---- */
app.post('/api/blocks/:id', auth, limit(60), (req, res) => {
  const me = req.user.id, other = +req.params.id;
  if (!other || other === me || !db.prepare('SELECT 1 FROM users WHERE id=?').get(other)) return res.status(400).json({ error: 'کاربر نامعتبر است' });
  if (req.body.block === false) db.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?').run(me, other);
  else db.prepare('INSERT OR IGNORE INTO blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)').run(me, other, Date.now());
  res.json({ blocked: blockedByMe(me, other) });
});
app.delete('/api/chats/:id', auth, (req, res) => {
  const me = req.user.id, other = +req.params.id;
  const last = db.prepare('SELECT MAX(id) m FROM messages WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?)').get(me, other, other, me).m || 0;
  db.prepare('INSERT INTO chat_clear(user_id,other_id,upto) VALUES(?,?,?) ON CONFLICT(user_id,other_id) DO UPDATE SET upto=excluded.upto').run(me, other, last);
  db.prepare('UPDATE messages SET read_at=? WHERE sender_id=? AND receiver_id=? AND read_at IS NULL').run(Date.now(), other, me);
  res.json({ ok: true });
});

/* ---- channels ---- */
db.exec(`
CREATE TABLE IF NOT EXISTS channels(id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, title TEXT NOT NULL,
  handle TEXT UNIQUE COLLATE NOCASE NOT NULL, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channel_subs(channel_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(channel_id, user_id));
CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_p ON posts(channel_id, id);
CREATE TABLE IF NOT EXISTS reactions(post_id INTEGER NOT NULL, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(post_id, user_id, kind));`);
if (!db.prepare('PRAGMA table_info(users)').all().some(x => x.name === 'rating')) {
  db.exec('ALTER TABLE users ADD COLUMN rating REAL NOT NULL DEFAULT 0');
  // یک‌بار: امتیاز را از تاریخچه‌ی هدیه‌ها و ری‌اکشن‌های ⭐ بازسازی می‌کنیم
  db.prepare(`UPDATE users SET rating =
    COALESCE((SELECT SUM(price) FROM gifts g WHERE g.sender_id=users.id), 0)
    - COALESCE((SELECT SUM(CAST(price*85/100 AS INTEGER)) FROM gifts g WHERE g.sender_id=users.id AND g.converted=1), 0)
    + 0.2 * COALESCE((SELECT SUM(n) FROM reactions r WHERE r.user_id=users.id AND r.kind=?), 0)`).run('⭐');
}
for (const [t, c, d] of [['channels', 'photo', "TEXT NOT NULL DEFAULT ''"], ['posts', 'img', "TEXT NOT NULL DEFAULT ''"], ['posts', 'gift_id', 'INTEGER'], ['posts', 'sender_id', 'INTEGER'], ['gifts', 'channel_id', 'INTEGER'], ['channels', 'pinned', 'INTEGER NOT NULL DEFAULT 0'], ['channels', 'sponsored', 'INTEGER NOT NULL DEFAULT 0'],
  ['channels', 'name_color', "TEXT NOT NULL DEFAULT ''"], ['channels', 'profile_color', "TEXT NOT NULL DEFAULT ''"], ['channels', 'emoji_status', "TEXT NOT NULL DEFAULT ''"],
  ['channels', 'bg_color', "TEXT NOT NULL DEFAULT ''"], ['channels', 'bg_img', "TEXT NOT NULL DEFAULT ''"]])
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
db.exec(`CREATE TABLE IF NOT EXISTS boosts(id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_boost_ch ON boosts(channel_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_boost_u ON boosts(user_id, created_at);`);
db.exec(`CREATE TABLE IF NOT EXISTS channel_emojis(id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL, img TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ce ON channel_emojis(channel_id);`);
setInterval(() => { try { db.prepare('DELETE FROM boosts WHERE expires_at<?').run(Date.now() - 864e5); } catch (e) {} }, 36e5).unref();
const saveImage = (dataUrl, name, maxBytes) => {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 100 || buf.length > maxBytes || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) return null;
  fs.writeFileSync(path.join(MEDIA, name), buf);
  return name;
};
const rmMedia = f => { if (f && /^[\w.-]+$/.test(f)) fs.unlink(path.join(MEDIA, f), () => {}); };
const mediaUrl = f => f ? '/media/' + f : '';
const STAR = '⭐';
const FREE_KINDS = ['👍', '❤️', '😂', '🔥', '😮', '🎉'];
const OLD_PREMIUM_KINDS = ['💎', '👑', '🚀', '🦄', '🌈', '⚡', '🤩', '🥳', '💯', '🫶', '🪐', '🐉'];
const PREMIUM_KINDS = [];
db.prepare('DELETE FROM reactions WHERE kind IN ('+OLD_PREMIUM_KINDS.map(()=>'?').join(',')+')').run(...OLD_PREMIUM_KINDS);
/* ---- بوست کانال (مثل تلگرام) ----
   هر کاربر روزی BOOST_DAILY بوست دارد (ریست ساعت ۰۰:۰۰ به وقت تهران) و می‌تواند هر تعداد از آن را روی هر کانال بگذارد.
   هر بوست BOOST_DAYS روز اعتبار دارد. آستانه‌ی سطح‌ها در BOOST_LEVELS و امکانات هر سطح در BOOST_PERKS است. */
const BOOST_DAILY = 100, BOOST_DAYS = 30, TZ_OFF = 3.5 * 3600e3;
const BOOST_LEVELS = [10, 25, 50, 100, 200, 350, 500, 750, 1000, 1500];
const BOOST_PERKS = [
  { lvl: 1, text: 'رنگ دلخواه برای نام کانال' }, { lvl: 2, text: 'رنگ هدر پروفایل کانال' }, { lvl: 3, text: 'ایموجی استاتوس کنار نام کانال' }, { lvl: 3, text: 'ایموجی‌های اختصاصی کانال (از روی عکس) و پس‌زمینه‌ی دلخواه' },
  { lvl: 4, text: 'پست‌های بلندتر (تا ۸۰۰۰ حرف)' }, { lvl: 5, text: 'اولویت بالاتر در نتایج جستجو' }];
const dayStart = (t = Date.now()) => Math.floor((t + TZ_OFF) / 864e5) * 864e5 - TZ_OFF;
const boostCount = id => db.prepare('SELECT COUNT(*) n FROM boosts WHERE channel_id=? AND expires_at>?').get(id, Date.now()).n;
const levelOf = n => BOOST_LEVELS.filter(t => n >= t).length;
const boostLeft = uid => Math.max(0, BOOST_DAILY - db.prepare('SELECT COUNT(*) n FROM boosts WHERE user_id=? AND created_at>=?').get(uid, dayStart()).n);
const boostPub = c => { const n = boostCount(c.id), lv = levelOf(n); return { count: n, level: lv, cur: lv ? BOOST_LEVELS[lv - 1] : 0, next: BOOST_LEVELS[lv] || null }; };
// ظاهر کانال بر اساس سطح (اگر سطح افت کند، انتخاب‌ها ذخیره می‌مانند ولی نمایش داده نمی‌شوند)
const chLook = c => { const lv = levelOf(boostCount(c.id));
  return { level: lv, nameColor: lv >= 1 ? c.name_color || '' : '', profileColor: lv >= 2 ? c.profile_color || '' : '', emojiStatus: lv >= 3 ? c.emoji_status || '' : '',
    bgColor: lv >= 3 ? c.bg_color || '' : '', bgImg: lv >= 3 ? mediaUrl(c.bg_img) : '' }; };
const CE_MAX = 10;
const chEmojis = c => levelOf(boostCount(c.id)) >= 3 ? db.prepare('SELECT id, img FROM channel_emojis WHERE channel_id=? ORDER BY id').all(c.id).map(e => ({ id: e.id, url: mediaUrl(e.img) })) : [];
const chInfo = (c, uid) => ({ id: c.id, title: c.title, handle: c.handle, description: c.description, ownerId: c.owner_id, photo: mediaUrl(c.photo),
  subs: db.prepare('SELECT COUNT(*) n FROM channel_subs WHERE channel_id=?').get(c.id).n,
  isSub: !!db.prepare('SELECT 1 FROM channel_subs WHERE channel_id=? AND user_id=?').get(c.id, uid), isOwner: c.owner_id === uid,
  ...chLook(c), pinned: !!c.pinned, sponsored: !!c.sponsored, emojis: chEmojis(c),
  stats: db.prepare("SELECT COUNT(*) posts, COALESCE(SUM(img!=''),0) photos FROM posts WHERE channel_id=? AND gift_id IS NULL").get(c.id),
  boost: { ...boostPub(c), mine: db.prepare('SELECT COUNT(*) n FROM boosts WHERE channel_id=? AND user_id=? AND expires_at>?').get(c.id, uid, Date.now()).n, left: boostLeft(uid), resetAt: dayStart() + 864e5 } });
const postsOf = (rows, uid) => {
  if (!rows.length) return [];
  const ids = rows.map(r => +r.id).join(',');
  const rx = db.prepare(`SELECT post_id, kind, SUM(n) c, SUM(CASE WHEN user_id=? THEN n ELSE 0 END) mine
    FROM reactions WHERE post_id IN (${ids}) GROUP BY post_id, kind`).all(uid);
  return rows.map(r => {
    const g = r.gift_id ? db.prepare('SELECT * FROM gifts WHERE id=?').get(r.gift_id) : null;
    const sd = g ? db.prepare('SELECT id,name,username FROM users WHERE id=?').get(g.sender_id) : null;
    return { id: r.id, channelId: r.channel_id, body: r.body, at: r.created_at, img: mediaUrl(r.img),
      gift: g ? { ...giftView(g), sender: sd || { id: 0, name: '—', username: '' } } : null,
      reactions: Object.fromEntries(rx.filter(x => x.post_id === r.id).map(x => [x.kind, { count: x.c, mine: x.mine }])) };
  });
};
const getCh = id => db.prepare('SELECT * FROM channels WHERE id=?').get(+id);

app.post('/api/channels', auth, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 60), handle = String(req.body.handle || '').trim().replace(/^@/, '');
  const description = String(req.body.description || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'نام کانال را بنویسید' });
  if (!/^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(handle)) return res.status(400).json({ error: 'لینک کانال باید ۳ تا ۳۲ حرف انگلیسی/عدد/_ باشد و با حرف شروع شود' });
  const maxCh = LIM(req.user).channels;
  if (db.prepare('SELECT COUNT(*) n FROM channels WHERE owner_id=?').get(req.user.id).n >= maxCh) return res.status(400).json({ error: `حداکثر ${maxCh} کانال می‌توانید بسازید` + (isPrem(req.user) ? '' : ' (پریمیوم: ۲۰ کانال)') });
  try {
    const r = db.prepare('INSERT INTO channels(owner_id,title,handle,description,created_at) VALUES(?,?,?,?,?)').run(req.user.id, title, handle, description, Date.now());
    const ph = req.body.photo ? saveImage(req.body.photo, `ch-${r.lastInsertRowid}-${Date.now()}.jpg`, 200e3) : null;
    if (ph) db.prepare('UPDATE channels SET photo=? WHERE id=?').run(ph, r.lastInsertRowid);
    db.prepare('INSERT INTO channel_subs VALUES(?,?)').run(r.lastInsertRowid, req.user.id);
    io.in('u:' + req.user.id).socketsJoin('c:' + r.lastInsertRowid);
    res.json({ channel: chInfo(getCh(r.lastInsertRowid), req.user.id) });
  } catch (e) { res.status(409).json({ error: 'این لینک قبلاً گرفته شده' }); }
});
app.get('/api/channels', auth, (req, res) => {
  const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM channel_subs WHERE channel_id=c.id) subs,
    (SELECT body FROM posts WHERE channel_id=c.id ORDER BY id DESC LIMIT 1) lb,
    (SELECT created_at FROM posts WHERE channel_id=c.id ORDER BY id DESC LIMIT 1) lt
    FROM channels c WHERE c.id IN (SELECT channel_id FROM channel_subs WHERE user_id=?) OR c.pinned>0 OR c.sponsored>0
    ORDER BY (c.pinned>0) DESC, c.pinned DESC, (c.sponsored>0) DESC, COALESCE(lt, c.created_at) DESC`).all(req.user.id);
  res.json({ channels: rows.map(c => ({ id: c.id, title: c.title, handle: c.handle, subs: c.subs, photo: mediaUrl(c.photo), pinned: !!c.pinned, sponsored: !!c.sponsored, ...chLook(c),
    last: c.lb ? { body: c.lb, at: c.lt } : null })) });
});
app.get('/api/channels/:id', auth, (req, res) => {
  const c = getCh(req.params.id);
  if (!c) return res.status(404).json({ error: 'کانال پیدا نشد' });
  const rows = db.prepare('SELECT * FROM posts WHERE channel_id=? ORDER BY id DESC LIMIT 50').all(c.id).reverse();
  res.json({ ch: chInfo(c, req.user.id), posts: postsOf(rows, req.user.id) });
});
app.patch('/api/channels/:id', auth, limit(60), (req, res) => {
  const c = getCh(req.params.id), b = req.body || {};
  if (!c) return res.status(404).json({ error: 'کانال پیدا نشد' });
  if (c.owner_id !== req.user.id) return res.status(403).json({ error: 'فقط مالک کانال می‌تواند آن را ویرایش کند' });
  const title = String(b.title ?? c.title).trim().slice(0, 60), description = String(b.description ?? c.description).trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'نام کانال را بنویسید' });
  let photo = c.photo;
  if (b.removePhoto) photo = '';
  else if (b.photo) {
    photo = saveImage(b.photo, `ch-${c.id}-${Date.now()}.jpg`, 200e3);
    if (!photo) return res.status(400).json({ error: 'تصویر نامعتبر یا حجیم است' });
  }
  if (photo !== c.photo) rmMedia(c.photo);
  const lv = levelOf(boostCount(c.id)), col = v => /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : '';
  let nc = c.name_color || '', pc = c.profile_color || '', es = c.emoji_status || '';
  const need = (n, msg) => `${msg}: کانال باید به سطح ${n} بوست برسد`;
  if (b.nameColor !== undefined) { const v = col(String(b.nameColor || '')); if (v !== nc) { if (v && lv < 1) return res.status(403).json({ error: need(1, 'رنگ نام') }); nc = v; } }
  if (b.profileColor !== undefined) { const v = col(String(b.profileColor || '')); if (v !== pc) { if (v && lv < 2) return res.status(403).json({ error: need(2, 'رنگ هدر') }); pc = v; } }
  if (b.emojiStatus !== undefined) { const v = String(b.emojiStatus || '').trim().slice(0, 8);
    if (v && /[A-Za-z0-9\s]/.test(v)) return res.status(400).json({ error: 'فقط یک ایموجی وارد کنید' });
    if (v !== es) { if (v && lv < 3) return res.status(403).json({ error: need(3, 'ایموجی استاتوس') }); es = v; } }
  let bc = c.bg_color || '', bi = c.bg_img || '';
  if (b.bgColor !== undefined) { const v = col(String(b.bgColor || '')); if (v !== bc) { if (v && lv < 3) return res.status(403).json({ error: need(3, 'پس‌زمینه') }); bc = v; } }
  if (b.removeBgPhoto) bi = '';
  else if (b.bgPhoto) {
    if (lv < 3) return res.status(403).json({ error: need(3, 'پس‌زمینه') });
    bi = saveImage(b.bgPhoto, `chbg-${c.id}-${Date.now()}.jpg`, 700e3);
    if (!bi) return res.status(400).json({ error: 'تصویر نامعتبر یا حجیم است' });
  }
  if (bi !== (c.bg_img || '')) rmMedia(c.bg_img);
  db.prepare('UPDATE channels SET title=?, description=?, photo=?, name_color=?, profile_color=?, emoji_status=?, bg_color=?, bg_img=? WHERE id=?').run(title, description, photo, nc, pc, es, bc, bi, c.id);
  const n = getCh(c.id);
  io.to('c:' + c.id).emit('chupdate', { id: n.id, title: n.title, description: n.description, photo: mediaUrl(n.photo), ...chLook(n), emojis: chEmojis(n) });
  res.json({ channel: chInfo(n, req.user.id) });
});
const ownCh = (req, res) => { const c = getCh(req.params.id);
  if (!c) { res.status(404).json({ error: 'کانال پیدا نشد' }); return null; }
  if (c.owner_id !== req.user.id) { res.status(403).json({ error: 'فقط مالک کانال' }); return null; }
  return c; };
const pushCh = c => io.to('c:' + c.id).emit('chupdate', { id: c.id, title: c.title, description: c.description, photo: mediaUrl(c.photo), ...chLook(c), emojis: chEmojis(c) });
app.post('/api/channels/:id/emojis', auth, limit(60), (req, res) => {
  const c = ownCh(req, res); if (!c) return;
  if (levelOf(boostCount(c.id)) < 3) return res.status(403).json({ error: 'ایموجی اختصاصی: کانال باید به سطح ۳ بوست برسد' });
  if (db.prepare('SELECT COUNT(*) n FROM channel_emojis WHERE channel_id=?').get(c.id).n >= CE_MAX) return res.status(400).json({ error: `حداکثر ${CE_MAX} ایموجی اختصاصی` });
  const f = saveImage(req.body.image, `ce-${c.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`, 100e3);
  if (!f) return res.status(400).json({ error: 'تصویر نامعتبر یا حجیم است' });
  db.prepare('INSERT INTO channel_emojis(channel_id,img,created_at) VALUES(?,?,?)').run(c.id, f, Date.now());
  pushCh(c); res.json({ emojis: chEmojis(c) });
});
app.delete('/api/channels/:id/emojis/:eid', auth, (req, res) => {
  const c = ownCh(req, res); if (!c) return;
  const e = db.prepare('SELECT * FROM channel_emojis WHERE id=? AND channel_id=?').get(+req.params.eid, c.id);
  if (!e) return res.status(404).json({ error: 'ایموجی پیدا نشد' });
  db.prepare('DELETE FROM channel_emojis WHERE id=?').run(e.id);
  db.prepare('DELETE FROM reactions WHERE kind=? AND post_id IN (SELECT id FROM posts WHERE channel_id=?)').run('ce:' + e.id, c.id);
  rmMedia(e.img); pushCh(c); res.json({ emojis: chEmojis(c) });
});
app.get('/api/channels/:id/gifts', auth, (req, res) => {
  const c = getCh(req.params.id);
  if (!c) return res.status(404).json({ error: 'کانال پیدا نشد' });
  const own = c.owner_id === req.user.id;
  const rows = db.prepare(`SELECT g.*, u.name sname, u.username suser FROM gifts g LEFT JOIN users u ON u.id=g.sender_id
    WHERE g.channel_id=? AND g.converted=0 ${own ? '' : 'AND g.hidden=0'} ORDER BY g.id DESC LIMIT 100`).all(c.id);
  res.json({ gifts: rows.map(r => ({ ...giftView(r), sender: { id: r.sender_id, name: r.sname || '—', username: r.suser || '' } })) });
});
app.post('/api/channels/:id/sub', auth, (req, res) => {
  const c = getCh(req.params.id);
  if (!c) return res.status(404).json({ error: 'کانال پیدا نشد' });
  if (c.owner_id === req.user.id) return res.status(400).json({ error: 'مالک نمی‌تواند کانال را ترک کند' });
  if (req.body.on) { db.prepare('INSERT OR IGNORE INTO channel_subs VALUES(?,?)').run(c.id, req.user.id); io.in('u:' + req.user.id).socketsJoin('c:' + c.id); }
  else { db.prepare('DELETE FROM channel_subs WHERE channel_id=? AND user_id=?').run(c.id, req.user.id); io.in('u:' + req.user.id).socketsLeave('c:' + c.id); }
  const i = chInfo(c, req.user.id); res.json({ isSub: i.isSub, subs: i.subs });
});
app.get('/api/channels/:id/boosts', auth, (req, res) => {
  const c = getCh(req.params.id);
  if (!c) return res.status(404).json({ error: 'کانال پیدا نشد' });
  const rows = db.prepare('SELECT user_id, COUNT(*) n FROM boosts WHERE channel_id=? AND expires_at>? GROUP BY user_id ORDER BY n DESC, MIN(created_at) LIMIT 50').all(c.id, Date.now());
  const boosters = rows.map(r => { const u = db.prepare('SELECT * FROM users WHERE id=? AND banned=0').get(r.user_id); return u && { ...pub(u), boosts: r.n }; }).filter(Boolean);
  res.json({ info: chInfo(c, req.user.id), levels: BOOST_LEVELS, perks: BOOST_PERKS, boosters, days: BOOST_DAYS, daily: BOOST_DAILY });
});
app.get('/api/channels/:id/members', auth, (req, res) => {
  const c = getCh(req.params.id);
  if (!c) return res.status(404).json({ error: 'کانال پیدا نشد' });
  const total = db.prepare('SELECT COUNT(*) n FROM channel_subs s JOIN users u ON u.id=s.user_id WHERE s.channel_id=? AND u.banned=0').get(c.id).n;
  const rows = db.prepare('SELECT u.* FROM channel_subs s JOIN users u ON u.id=s.user_id WHERE s.channel_id=? AND u.banned=0 ORDER BY (u.id=?) DESC, s.rowid LIMIT 300').all(c.id, c.owner_id);
  res.json({ total, members: rows.map(u => ({ ...pub(u), isOwner: u.id === c.owner_id })) });
});
app.post('/api/channels/:id/boost', auth, limit(120), (req, res) => {
  const c = getCh(req.params.id);
  if (!c) return res.status(404).json({ error: 'کانال پیدا نشد' });
  let n = Math.floor(+req.body.n || 1);
  if (!(n >= 1)) return res.status(400).json({ error: 'تعداد بوست نامعتبر است' });
  const uid = req.user.id, now = Date.now();
  const added = db.transaction(() => {
    const left = boostLeft(uid);
    if (left < 1) return -1;
    n = Math.min(n, left);
    const ins = db.prepare('INSERT INTO boosts(channel_id,user_id,created_at,expires_at) VALUES(?,?,?,?)');
    for (let i = 0; i < n; i++) ins.run(c.id, uid, now, now + BOOST_DAYS * 864e5);
    return n;
  })();
  if (added < 0) return res.status(429).json({ error: 'بوست‌های امروزتان تمام شده؛ فردا دوباره ۱۰۰ بوست دارید' });
  io.to('c:' + c.id).emit('chboost', { id: c.id, boost: boostPub(c), ...chLook(c) });
  res.json({ info: chInfo(c, uid), added });
});
app.post('/api/channels/:id/posts', auth, limit(200), (req, res) => {
  const c = getCh(req.params.id);
  if (!c) return res.status(404).json({ error: 'کانال پیدا نشد' });
  if (c.owner_id !== req.user.id) return res.status(403).json({ error: 'فقط مالک کانال می‌تواند پست بگذارد' });
  const body = stripPe(req.user, String(req.body.body || '').trim().slice(0, Math.max(LIM(req.user).msg, levelOf(boostCount(c.id)) >= 4 ? 8000 : 0))).trim();
  if (!body && !req.body.image) return res.status(400).json({ error: 'متن پست خالی است' });
  const r = db.prepare('INSERT INTO posts(channel_id,body,created_at) VALUES(?,?,?)').run(c.id, body, Date.now());
  if (req.body.image) {
    const f = saveImage(req.body.image, `post-${r.lastInsertRowid}.jpg`, 700e3);
    if (!f) { db.prepare('DELETE FROM posts WHERE id=?').run(r.lastInsertRowid); return res.status(400).json({ error: 'تصویر نامعتبر یا حجیم است' }); }
    db.prepare('UPDATE posts SET img=? WHERE id=?').run(f, r.lastInsertRowid);
  }
  const post = postsOf([db.prepare('SELECT * FROM posts WHERE id=?').get(r.lastInsertRowid)], req.user.id)[0];
  io.to('c:' + c.id).emit('post', post);
  res.json({ post });
});
app.post('/api/posts/:id/react', auth, (req, res) => {
  const post = db.prepare('SELECT p.*, c.owner_id FROM posts p JOIN channels c ON c.id=p.channel_id WHERE p.id=?').get(+req.params.id);
  if (!post) return res.status(404).json({ error: 'پست پیدا نشد' });
  const kind = req.body.kind, uid = req.user.id;
  if (kind === STAR) {
    if (post.owner_id === uid) return res.status(400).json({ error: 'به پست خودتان نمی‌توانید ⭐ بدهید' });
    const ok = db.transaction(() => {
      if (!db.prepare('UPDATE users SET stars=stars-1 WHERE id=? AND stars>=1').run(uid).changes) return false;
      db.prepare('UPDATE users SET stars=stars+1 WHERE id=?').run(post.owner_id);
      db.prepare('UPDATE users SET rating=rating+? WHERE id=?').run(RATING_PER_STAR_REACTION, uid);
      db.prepare('INSERT INTO reactions(post_id,user_id,kind,n) VALUES(?,?,?,1) ON CONFLICT(post_id,user_id,kind) DO UPDATE SET n=n+1').run(post.id, uid, kind);
      return true;
    })();
    if (!ok) return res.status(402).json({ error: 'استارز شما کافی نیست' });
  } else if (FREE_KINDS.includes(kind) || PREMIUM_KINDS.includes(kind) || /^ce:\d+$/.test(kind) || /^pe:\d+$/.test(kind)) {
    if (/^ce:/.test(kind) && (levelOf(boostCount(post.channel_id)) < 3 || !db.prepare('SELECT 1 FROM channel_emojis WHERE id=? AND channel_id=?').get(+kind.slice(3), post.channel_id)))
      return res.status(400).json({ error: 'ایموجی نامعتبر' });
    if (/^pe:/.test(kind) && (!isPrem(req.user) || !pemojiOk(kind))) return res.status(403).json({ error: 'این ایموجی ویژه‌ی کاربران پریمیوم است' });
    if (PREMIUM_KINDS.includes(kind) && !isPrem(req.user)) return res.status(403).json({ error: 'این ری‌اکشن ویژه‌ی کاربران پریمیوم است' });
    if (!db.prepare('DELETE FROM reactions WHERE post_id=? AND user_id=? AND kind=?').run(post.id, uid, kind).changes)
      db.prepare('INSERT INTO reactions(post_id,user_id,kind,n) VALUES(?,?,?,1)').run(post.id, uid, kind);
  } else return res.status(400).json({ error: 'ری‌اکشن نامعتبر' });
  const r = db.prepare('SELECT COALESCE(SUM(n),0) c, COALESCE(SUM(CASE WHEN user_id=? THEN n ELSE 0 END),0) mine FROM reactions WHERE post_id=? AND kind=?').get(uid, post.id, kind);
  const stars = id => db.prepare('SELECT stars FROM users WHERE id=?').get(id).stars;
  io.to('c:' + post.channel_id).emit('reaction', { postId: post.id, kind, count: r.c });
  if (kind === STAR) {
    io.to('u:' + uid).emit('account', { stars: stars(uid), ...ratingOf(uid) });
    if (post.owner_id !== uid) io.to('u:' + post.owner_id).emit('account', { stars: stars(post.owner_id) });
  }
  res.json({ count: r.c, mine: r.mine, stars: stars(uid), ...ratingOf(uid) });
});

/* ---- premium ---- */
app.get('/api/premium', auth, (_, res) => res.json({ plans: Object.entries(PREMIUM_PLANS).map(([id, p]) => ({ id, ...p })) }));
app.post('/api/premium/buy', auth, limit(40), (req, res) => {
  const p = PREMIUM_PLANS[req.body.plan], uid = req.user.id, to = +req.body.to || uid;
  const note = String(req.body.note || '').trim().slice(0, 100);
  if (!p) return res.status(400).json({ error: 'پلن نامعتبر است' });
  if (!db.prepare('SELECT 1 FROM users WHERE id=? AND banned=0').get(to)) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  if (to !== uid && blockedEither(uid, to)) return res.status(403).json({ error: 'امکان ارسال به این کاربر وجود ندارد' });
  let mid = 0;
  const ok = db.transaction(() => {
    if (!db.prepare('UPDATE users SET stars=stars-? WHERE id=? AND stars>=?').run(p.price, uid, p.price).changes) return false;
    db.prepare('UPDATE users SET premium_until=MAX(premium_until, ?) + ? WHERE id=?').run(Date.now(), p.months * 30 * 864e5, to);
    if (to !== uid) mid = db.prepare('INSERT INTO messages(sender_id,receiver_id,body,created_at,special) VALUES(?,?,?,?,?)')
      .run(uid, to, `👑 هدیه‌ی پریمیوم ${p.months} ماهه`, Date.now(), JSON.stringify({ t: 'prem', m: p.months, n: note })).lastInsertRowid;
    return true;
  })();
  if (!ok) return res.status(402).json({ error: 'استارز شما کافی نیست' });
  const t = db.prepare('SELECT * FROM users WHERE id=?').get(to);
  io.to('u:' + to).emit('account', { premium: true, premiumUntil: t.premium_until });
  io.to('u:' + uid).emit('account', { stars: starsOf(uid) });
  if (mid) io.to('u:' + uid).to('u:' + to).emit('message', fmt(db.prepare('SELECT * FROM messages WHERE id=?').get(mid)));
  res.json({ me: mine(db.prepare('SELECT * FROM users WHERE id=?').get(uid)), gifted: to !== uid, special: { t: 'prem', m: p.months, n: note } });
});

/* ---- پک استارز (هدیه‌ی ⭐ با انیمیشن) ---- */
app.get('/api/packs', auth, (_, res) => res.json({ packs: STAR_PACKS }));
app.post('/api/packs/send', auth, limit(40), (req, res) => {
  const pk = STAR_PACKS.find(x => x.id === req.body.pack), uid = req.user.id, to = +req.body.to;
  const note = String(req.body.note || '').trim().slice(0, 100);
  if (!pk) return res.status(400).json({ error: 'پک نامعتبر است' });
  if (!to || to === uid) return res.status(400).json({ error: 'گیرنده نامعتبر است' });
  if (!db.prepare('SELECT 1 FROM users WHERE id=? AND banned=0').get(to)) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  if (blockedEither(uid, to)) return res.status(403).json({ error: 'امکان ارسال به این کاربر وجود ندارد' });
  const special = { t: 'pack', id: pk.id, s: pk.stars, nm: pk.name, c1: pk.c1, c2: pk.c2, n: note };
  let mid = 0;
  const ok = db.transaction(() => {
    // کسر و افزایش در یک تراکنش: یا هر دو انجام می‌شود یا هیچ‌کدام
    if (!db.prepare('UPDATE users SET stars=stars-? WHERE id=? AND stars>=?').run(pk.stars, uid, pk.stars).changes) return false;
    db.prepare('UPDATE users SET stars=stars+? WHERE id=?').run(pk.stars, to);
    // عمداً به «رتبه/لول» امتیاز نمی‌دهد (جلوگیری از رد و بدل کردن ⭐ برای بالا بردن لول)
    mid = db.prepare('INSERT INTO messages(sender_id,receiver_id,body,created_at,special) VALUES(?,?,?,?,?)')
      .run(uid, to, `⭐ پک استارز ${pk.name} (${pk.stars})`, Date.now(), JSON.stringify(special)).lastInsertRowid;
    return true;
  })();
  if (!ok) return res.status(402).json({ error: 'استارز شما کافی نیست' });
  io.to('u:' + uid).to('u:' + to).emit('message', fmt(db.prepare('SELECT * FROM messages WHERE id=?').get(mid)));
  io.to('u:' + uid).emit('account', { stars: starsOf(uid) });
  io.to('u:' + to).emit('account', { stars: starsOf(to) });
  res.json({ stars: starsOf(uid), special });
});

/* ---- gifts ---- */
const starsOf = id => db.prepare('SELECT stars FROM users WHERE id=?').get(id).stars;
app.get('/api/gifts', auth, (_, res) => res.json({ gifts: GIFTS, refundRate: 0.85, ton: tonView(),
  limited: db.prepare('SELECT * FROM limited_gifts WHERE active=1 ORDER BY id DESC').all().map(limView) }));
app.post('/api/gifts/send', auth, limit(60), (req, res) => {
  const limId = +req.body.limited || 0, uid = req.user.id;
  const ch = req.body.channel ? getCh(req.body.channel) : null;
  if (req.body.channel && !ch) return res.status(404).json({ error: 'کانال پیدا نشد' });
  const to = ch ? ch.owner_id : +req.body.to;
  const note = String(req.body.note || '').trim().slice(0, 100);
  const g = limId ? null : GIFTS.find(x => x.key === req.body.gift);
  if (!limId && !g) return res.status(400).json({ error: 'هدیه نامعتبر است' });
  if (!to) return res.status(400).json({ error: 'گیرنده نامعتبر است' });
  if (!db.prepare('SELECT 1 FROM users WHERE id=? AND banned=0').get(to)) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  if (to !== uid && blockedEither(uid, to)) return res.status(403).json({ error: 'امکان ارسال به این کاربر وجود ندارد' });
  let mid = 0, pid = 0;
  try {
    db.transaction(() => {
      let price, key, serial = null, body, traits = null;
      if (limId) {
        const L = db.prepare('SELECT * FROM limited_gifts WHERE id=? AND active=1').get(limId);
        if (!L) throw new Error('gone');
        price = starPrice(L);
        const exp = +req.body.expect;
        if (exp > 0 && exp !== price) { const pe = new Error('price'); pe.price = price; throw pe; }
        if (!db.prepare('UPDATE limited_gifts SET sold=sold+1 WHERE id=? AND sold<supply').run(limId).changes) throw new Error('soldout');
        serial = db.prepare('SELECT sold FROM limited_gifts WHERE id=?').get(limId).sold;
        traits = JSON.stringify(rollTraits()); key = 'limited'; body = `💠 ${L.img ? '' : L.emoji + ' '}${L.name} #${serial}`;
      } else { price = g.price; key = g.key; body = `🎁 ${g.emoji} ${g.name}`; }
      if (!db.prepare('UPDATE users SET stars=stars-? WHERE id=? AND stars>=?').run(price, uid, price).changes) throw new Error('stars');
      // رتبه: هر ⭐ هدیه = ۱ امتیاز (مثل تلگرام)
      db.prepare('UPDATE users SET rating=rating+? WHERE id=?').run(price, uid);
      const r = db.prepare('INSERT INTO gifts(sender_id,receiver_id,gift_key,price,note,created_at,lim_id,serial,channel_id,traits) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(uid, to, key, price, note, Date.now(), limId || null, serial, ch ? ch.id : null, traits);
      if (ch) pid = db.prepare('INSERT INTO posts(channel_id,body,created_at,gift_id,sender_id) VALUES(?,?,?,?,?)')
        .run(ch.id, body, Date.now(), r.lastInsertRowid, uid).lastInsertRowid;
      else if (to !== uid) mid = db.prepare('INSERT INTO messages(sender_id,receiver_id,body,created_at,gift_id) VALUES(?,?,?,?,?)')
        .run(uid, to, body, Date.now(), r.lastInsertRowid).lastInsertRowid;
    })();
  } catch (e) {
    if (e.message === 'price') return res.status(409).json({ error: `نرخ TON تغییر کرد؛ قیمت جدید ⭐ ${e.price}`, price: e.price });
    const m = { stars: [402, 'استارز شما کافی نیست'], soldout: [409, 'این هدیه‌ی لیمیتد تمام شده است'], gone: [404, 'این هدیه دیگر موجود نیست'] }[e.message];
    if (m) return res.status(m[0]).json({ error: m[1] });
    throw e;
  }
  if (pid) io.to('c:' + ch.id).emit('post', postsOf([db.prepare('SELECT * FROM posts WHERE id=?').get(pid)], uid)[0]);
  if (mid) io.to('u:' + uid).to('u:' + to).emit('message', fmt(db.prepare('SELECT * FROM messages WHERE id=?').get(mid)));
  io.to('u:' + uid).emit('account', { stars: starsOf(uid), ...ratingOf(uid) });
  res.json({ stars: starsOf(uid), ...ratingOf(uid) });
});
app.get('/api/users/:id/gifts', auth, (req, res) => {
  const id = +req.params.id, own = id === req.user.id;
  const rows = db.prepare(`SELECT g.*, u.name sname, u.username suser FROM gifts g LEFT JOIN users u ON u.id=g.sender_id
    WHERE g.receiver_id=? AND g.channel_id IS NULL AND g.converted=0 ${own ? '' : 'AND g.hidden=0'} ORDER BY g.id DESC LIMIT 100`).all(id);
  res.json({ gifts: rows.map(r => ({ ...giftView(r), sender: { id: r.sender_id, name: r.sname || '—', username: r.suser || '' } })) });
});
app.post('/api/gifts/:id/convert', auth, (req, res) => {
  const g = db.prepare('SELECT * FROM gifts WHERE id=?').get(+req.params.id);
  if (!g || g.receiver_id !== req.user.id) return res.status(404).json({ error: 'هدیه پیدا نشد' });
  if (g.staked) return res.status(409).json({ error: 'این NFT الان در بازی انفجار است' });
  if (g.listed) return res.status(409).json({ error: 'این NFT در پورتال برای فروش گذاشته شده؛ اول آگهی را لغو کنید' });
  const back = refundOf(valueOf(g)), ratingBack = refundOf(g.price);
  const ok = db.transaction(() => {
    if (!db.prepare('UPDATE gifts SET converted=1 WHERE id=? AND converted=0 AND staked=0 AND listed=0').run(g.id).changes) return false;
    db.prepare('UPDATE users SET stars=stars+? WHERE id=?').run(back, g.receiver_id);
    db.prepare('UPDATE users SET profile_gift=0 WHERE id=? AND profile_gift=?').run(g.receiver_id, g.id);
    db.prepare('UPDATE users SET rating=rating-? WHERE id=?').run(ratingBack, g.sender_id); // مثل تلگرام: تبدیل هدیه به ⭐ از امتیاز خریدار کم می‌کند
    return true;
  })();
  if (!ok) return res.status(400).json({ error: 'این هدیه قبلاً تبدیل شده' });
  io.to('u:' + g.receiver_id).emit('account', { stars: starsOf(g.receiver_id), ...(g.sender_id === g.receiver_id ? ratingOf(g.sender_id) : {}) });
  if (g.sender_id !== g.receiver_id) io.to('u:' + g.sender_id).emit('account', ratingOf(g.sender_id));
  io.to('u:' + g.receiver_id).to('u:' + g.sender_id).emit('giftupdate', { id: g.id, converted: true });
  if (g.channel_id) io.to('c:' + g.channel_id).emit('giftupdate', { id: g.id, converted: true });
  res.json({ stars: starsOf(g.receiver_id), back });
});
app.post('/api/gifts/:id/hide', auth, (req, res) => {
  const g = db.prepare('SELECT * FROM gifts WHERE id=?').get(+req.params.id);
  if (!g || g.receiver_id !== req.user.id) return res.status(404).json({ error: 'هدیه پیدا نشد' });
  db.prepare('UPDATE gifts SET hidden=? WHERE id=?').run(+!!req.body.hidden, g.id);
  res.json({ hidden: !!req.body.hidden });
});

/* ---- انتقال NFT و ربات «پورتال» (بازار NFT) ----
   انتقال: مالک یک NFT لیمیتد را مستقیم به کاربر دیگری می‌دهد (رایگان؛ ارزش و ویژگی‌ها همراهش می‌ماند).
   پورتال: مالک NFT را برای فروش می‌گذارد؛ قیمت آگهی = ارزش فعلی NFT + ۱۰٪ (PORTAL_MARKUP) و در لحظه‌ی ثبت ثابت می‌شود.
   NFTِ آگهی‌شده قفل است (listed=1): نه تبدیل می‌شود، نه منتقل، نه در انفجار شرط می‌شود. خریدار قیمت کامل را می‌دهد و فروشنده کل آن را می‌گیرد. */
const PORTAL_MARKUP = 0.10;
const TRANSFER_TAX = 0.50;   // مالیات انتقال: ٪۵۰ ارزش NFT از ⭐ فرستنده کم می‌شود (ارزش خود NFT تغییر نمی‌کند)
const transferTax = v => Math.ceil(v * TRANSFER_TAX - 1e-9);
const portalPrice = v => Math.ceil(v * (1 + PORTAL_MARKUP) - 1e-9);
db.exec(`CREATE TABLE IF NOT EXISTS portal_listings(id INTEGER PRIMARY KEY, gift_id INTEGER NOT NULL, seller_id INTEGER NOT NULL, price INTEGER NOT NULL,
  created_at INTEGER NOT NULL, status INTEGER NOT NULL DEFAULT 0, buyer_id INTEGER, sold_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_pl ON portal_listings(status, id);`);
const myNft = (id, uid) => db.prepare('SELECT * FROM gifts WHERE id=? AND receiver_id=? AND channel_id IS NULL AND lim_id IS NOT NULL AND converted=0').get(id, uid);
const plView = r => { const g = db.prepare('SELECT * FROM gifts WHERE id=?').get(r.gift_id), sl = db.prepare('SELECT id,name,username FROM users WHERE id=?').get(r.seller_id);
  return { id: r.id, price: r.price, at: r.created_at, seller: sl || { id: 0, name: '—', username: '' }, gift: g ? giftView(g) : null }; };
app.post('/api/gifts/:id/transfer', auth, limit(60), (req, res) => {
  const uid = req.user.id, to = +req.body.to, g = myNft(+req.params.id, uid);
  if (!g) return res.status(404).json({ error: 'این NFT پیدا نشد' });
  if (!to || to === uid) return res.status(400).json({ error: 'گیرنده نامعتبر است' });
  if (!db.prepare('SELECT 1 FROM users WHERE id=? AND banned=0').get(to)) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  if (blockedEither(uid, to)) return res.status(403).json({ error: 'امکان ارسال به این کاربر وجود ندارد' });
  if (g.staked) return res.status(409).json({ error: 'این NFT الان در بازی انفجار است' });
  if (g.listed) return res.status(409).json({ error: 'این NFT در پورتال برای فروش گذاشته شده؛ اول آگهی را لغو کنید' });
  let mid = 0;
  const tax = transferTax(valueOf(g));
  if (starsOf(uid) < tax) return res.status(402).json({ error: `برای انتقال باید ⭐ ${tax} مالیات (۵۰٪ ارزش NFT) داشته باشید` });
  const ok = db.transaction(() => {
    if (tax > 0 && !db.prepare('UPDATE users SET stars=stars-? WHERE id=? AND stars>=?').run(tax, uid, tax).changes) return false;
    if (!db.prepare('UPDATE gifts SET receiver_id=?, hidden=0 WHERE id=? AND receiver_id=? AND staked=0 AND listed=0 AND converted=0').run(to, g.id, uid).changes) return false;
    db.prepare('UPDATE users SET profile_gift=0 WHERE id=? AND profile_gift=?').run(uid, g.id);
    const v = giftView(g);
    mid = db.prepare('INSERT INTO messages(sender_id,receiver_id,body,created_at,gift_id) VALUES(?,?,?,?,?)')
      .run(uid, to, `🔁 انتقال NFT: ${v.limited && v.limited.img ? '' : v.emoji + ' '}${v.name} #${g.serial}`, Date.now(), g.id).lastInsertRowid;
    return true; })();
  if (!ok) return res.status(409).json({ error: 'این NFT الان در دسترس نیست یا استارز کافی نیست' });
  io.to('u:' + uid).emit('account', { stars: starsOf(uid) });
  io.to('u:' + uid).to('u:' + to).emit('message', fmt(db.prepare('SELECT * FROM messages WHERE id=?').get(mid)));
  io.to('u:' + uid).to('u:' + to).emit('giftupdate', { id: g.id, converted: false, moved: true });
  res.json({ ok: true, tax, stars: starsOf(uid) });
});
app.get('/api/portal', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM portal_listings WHERE status=0 ORDER BY id DESC LIMIT 100').all();
  res.json({ markup: PORTAL_MARKUP, tax: TRANSFER_TAX, ton: tonView(), stars: starsOf(req.user.id), listings: rows.map(plView).filter(x => x.gift) });
});
app.post('/api/portal/list', auth, limit(60), (req, res) => {
  const uid = req.user.id, g = myNft(+req.body.gift, uid);
  if (!g) return res.status(404).json({ error: 'این NFT پیدا نشد' });
  if (g.staked) return res.status(409).json({ error: 'این NFT الان در بازی انفجار است' });
  if (g.listed) return res.status(409).json({ error: 'این NFT قبلاً در پورتال گذاشته شده' });
  const price = portalPrice(valueOf(g));
  if (price < 1) return res.status(400).json({ error: 'این NFT ارزشی ندارد' });
  let id = 0;
  const ok = db.transaction(() => {
    if (!db.prepare('UPDATE gifts SET listed=1 WHERE id=? AND receiver_id=? AND staked=0 AND listed=0 AND converted=0').run(g.id, uid).changes) return false;
    db.prepare('UPDATE users SET profile_gift=0 WHERE id=? AND profile_gift=?').run(uid, g.id);
    id = db.prepare('INSERT INTO portal_listings(gift_id,seller_id,price,created_at) VALUES(?,?,?,?)').run(g.id, uid, price, Date.now()).lastInsertRowid;
    return true; })();
  if (!ok) return res.status(409).json({ error: 'این NFT الان در دسترس نیست' });
  io.to('u:' + uid).emit('giftupdate', { id: g.id, converted: false, moved: true });
  res.json({ ok: true, id, price });
});
app.post('/api/portal/:id/cancel', auth, (req, res) => {
  const uid = req.user.id, r = db.prepare('SELECT * FROM portal_listings WHERE id=? AND status=0').get(+req.params.id);
  if (!r || r.seller_id !== uid) return res.status(404).json({ error: 'آگهی پیدا نشد' });
  const ok = db.transaction(() => {
    if (!db.prepare('UPDATE portal_listings SET status=2 WHERE id=? AND status=0').run(r.id).changes) return false;
    db.prepare('UPDATE gifts SET listed=0 WHERE id=?').run(r.gift_id); return true; })();
  if (!ok) return res.status(409).json({ error: 'این آگهی دیگر فعال نیست' });
  io.to('u:' + uid).emit('giftupdate', { id: r.gift_id, converted: false, moved: true });
  res.json({ ok: true });
});
app.post('/api/portal/:id/buy', auth, limit(60), (req, res) => {
  const uid = req.user.id, r = db.prepare('SELECT * FROM portal_listings WHERE id=? AND status=0').get(+req.params.id);
  if (!r) return res.status(404).json({ error: 'این آگهی دیگر موجود نیست' });
  if (r.seller_id === uid) return res.status(400).json({ error: 'نمی‌توانید NFT خودتان را بخرید' });
  const exp = +req.body.expect;
  if (exp > 0 && exp !== r.price) return res.status(409).json({ error: 'قیمت آگهی تغییر کرد' });
  if (blockedEither(uid, r.seller_id)) return res.status(403).json({ error: 'امکان خرید از این کاربر وجود ندارد' });
  let err = '';
  try { db.transaction(() => {
    if (!db.prepare('UPDATE portal_listings SET status=1, buyer_id=?, sold_at=? WHERE id=? AND status=0').run(uid, Date.now(), r.id).changes) { err = 'gone'; return; }
    if (!db.prepare('UPDATE users SET stars=stars-? WHERE id=? AND stars>=?').run(r.price, uid, r.price).changes) { err = 'stars'; throw new Error('stars'); }
    db.prepare('UPDATE users SET stars=stars+? WHERE id=?').run(r.price, r.seller_id);
    db.prepare('UPDATE gifts SET receiver_id=?, listed=0, hidden=0 WHERE id=? AND listed=1').run(uid, r.gift_id);
    db.prepare('UPDATE users SET profile_gift=0 WHERE id=? AND profile_gift=?').run(r.seller_id, r.gift_id);
  })(); } catch (e) { if (err !== 'stars') throw e; }
  if (err === 'stars') return res.status(402).json({ error: 'استارز شما کافی نیست' });
  if (err === 'gone') return res.status(404).json({ error: 'این آگهی دیگر موجود نیست' });
  io.to('u:' + uid).emit('account', { stars: starsOf(uid) });
  io.to('u:' + r.seller_id).emit('account', { stars: starsOf(r.seller_id) });
  io.to('u:' + r.seller_id).emit('portal', { t: 'sold', price: r.price, gift: r.gift_id });
  io.to('u:' + uid).to('u:' + r.seller_id).emit('giftupdate', { id: r.gift_id, converted: false, moved: true });
  res.json({ ok: true, stars: starsOf(uid) });
});

/* ---- admin ---- */
const adm = (req, res, next) => req.signedCookies.adm === '1' ? next() : res.status(401).json({ error: 'unauthorized' });
const full = u => ({ id: u.id, username: u.username, name: u.name, country: u.country, number: u.pass_hash ? '' : u.number, banned: !!u.banned,
  premium: !!u.premium, until: u.premium_until || 0, stars: u.stars, online: online.has(u.id), lastSeen: u.last_seen,
  tag: USER_TAGS[u.admin_tag] ? u.admin_tag : '' });
app.get('/api/admin/backup', adm, async (req, res) => {
  const f = path.join(DATA, `backup-${Date.now()}.db`);
  try { await db.backup(f); res.download(f, 'novingram-backup.db', () => fs.unlink(f, () => {})); }
  catch (e) { res.status(500).json({ error: 'backup failed' }); }
});
/* ---- بازگردانی بکاپ: فایل .db آپلود می‌شود و جایگزین محتوای دیتابیس فعلی می‌شود (بدون ری‌استارت) ---- */
app.post('/api/admin/restore', adm, express.raw({ type: () => true, limit: '300mb' }), async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 100 || buf.slice(0, 15).toString() !== 'SQLite format 3')
    return res.status(400).json({ error: 'این فایل یک بکاپ معتبر (.db) نیست' });
  const tmp = path.join(DATA, `restore-${Date.now()}.db`);
  fs.writeFileSync(tmp, buf);
  const cleanup = () => fs.unlink(tmp, () => {});
  try {
    const chk = new Database(tmp, { readonly: true });
    let okDb = false;
    try {
      okDb = chk.pragma('integrity_check', { simple: true }) === 'ok'
        && ['users', 'messages'].every(t => chk.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
    } finally { chk.close(); }
    if (!okDb) { cleanup(); return res.status(400).json({ error: 'فایل بکاپ خراب است یا مال این برنامه نیست' }); }
    // نسخه‌ی امنِ وضعیت فعلی قبل از جایگزینی
    const safe = path.join(DATA, `pre-restore-${Date.now()}.db`);
    await db.backup(safe);
    db.exec(`ATTACH DATABASE '${tmp.replace(/'/g, "''")}' AS bk`);
    let n = 0;
    try {
      db.transaction(() => {
        const main = db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
        const bk = new Set(db.prepare("SELECT name FROM bk.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name));
        for (const t of main) {
          db.exec(`DELETE FROM main."${t}"`);
          if (!bk.has(t)) continue;
          const mc = db.prepare(`PRAGMA main.table_info("${t}")`).all().map(c => c.name);
          const bc = new Set(db.prepare(`PRAGMA bk.table_info("${t}")`).all().map(c => c.name));
          const cols = mc.filter(c => bc.has(c)).map(c => `"${c}"`).join(',');
          if (cols) { db.exec(`INSERT INTO main."${t}"(${cols}) SELECT ${cols} FROM bk."${t}"`); n++; }
        }
      })();
    } finally { db.exec('DETACH DATABASE bk'); }
    cleanup();
    io.emit('chpromo', {});
    res.json({ ok: true, tables: n, safeCopy: path.basename(safe) });
  } catch (e) {
    cleanup();
    console.error('restore failed', e);
    res.status(500).json({ error: 'بازگردانی ناموفق بود؛ داده‌ی فعلی تغییری نکرد' });
  }
});
app.get('/api/admin/limited', adm, (_, res) =>
  res.json({ items: db.prepare('SELECT * FROM limited_gifts ORDER BY id DESC').all().map(limView) }));
const parseTon = v => { const n = +v; return Number.isFinite(n) && n >= 0.0001 && n <= 1e6 ? r4(n) : null; };
const saveNft = img => saveEmoji(img, `lg-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, 400e3);
const NFT_IMG_ERR = 'عکس هدیه معتبر نیست (PNG یا WebP، حداکثر ۴۰۰ کیلوبایت)';
app.post('/api/admin/limited', adm, limit(60), (req, res) => {
  const b = req.body || {}, name = String(b.name || '').trim().slice(0, 30);
  const color = /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : '#3390ec', supply = +b.supply;
  let emoji = String(b.emoji || '').trim().slice(0, 8);
  const tonPrice = b.priceTon === '' || b.priceTon == null ? null : parseTon(b.priceTon);
  if (b.priceTon !== '' && b.priceTon != null && tonPrice == null) return res.status(400).json({ error: 'قیمت TON نامعتبر است' });
  const price = tonPrice != null ? Math.max(1, Math.round(tonPrice * tonRate())) : +b.price;
  if (!name) return res.status(400).json({ error: 'نام هدیه را وارد کنید' });
  if (!emoji && !b.image) return res.status(400).json({ error: 'ایموجی یا عکس هدیه را بدهید' });
  if (!Number.isInteger(price) || price < 1 || price > 1e6) return res.status(400).json({ error: 'قیمت باید عدد صحیح ≥ ۱ باشد (یا قیمت TON بدهید)' });
  if (!Number.isInteger(supply) || supply < 1 || supply > 1e6) return res.status(400).json({ error: 'تعداد باید عدد صحیح ≥ ۱ باشد' });
  let img = '';
  if (b.image) { img = saveNft(b.image); if (!img) return res.status(400).json({ error: NFT_IMG_ERR }); }
  if (!emoji) emoji = '💠';
  const r = db.prepare('INSERT INTO limited_gifts(name,emoji,price,supply,color,created_at,price_gram,img) VALUES(?,?,?,?,?,?,?,?)').run(name, emoji, price, supply, color, Date.now(), tonPrice, img);
  res.json({ item: limView(db.prepare('SELECT * FROM limited_gifts WHERE id=?').get(r.lastInsertRowid)) });
});
app.post('/api/admin/limited/:id', adm, limit(60), (req, res) => {
  const id = +req.params.id, b = req.body || {}, L = db.prepare('SELECT * FROM limited_gifts WHERE id=?').get(id);
  if (!L) return res.status(404).json({ error: 'not found' });
  if (typeof b.active === 'boolean') db.prepare('UPDATE limited_gifts SET active=? WHERE id=?').run(+b.active, id);
  if ('priceTon' in b) {   // عدد = قیمت بر پایه‌ی TON؛ null = برگشت به قیمت ثابت ⭐
    if (b.priceTon === null) db.prepare('UPDATE limited_gifts SET price=?, price_gram=NULL WHERE id=?').run(starPrice(L), id);
    else { const g = parseTon(b.priceTon); if (g == null) return res.status(400).json({ error: 'قیمت TON نامعتبر است' });
      db.prepare('UPDATE limited_gifts SET price_gram=? WHERE id=?').run(g, id); }
  }
  if ('price' in b) { const p = +b.price; if (!Number.isInteger(p) || p < 1 || p > 1e6) return res.status(400).json({ error: 'قیمت باید عدد صحیح ≥ ۱ باشد' });
    db.prepare('UPDATE limited_gifts SET price=?, price_gram=NULL WHERE id=?').run(p, id); }
  if (b.image) { const f = saveNft(b.image); if (!f) return res.status(400).json({ error: NFT_IMG_ERR });
    db.prepare('UPDATE limited_gifts SET img=? WHERE id=?').run(f, id); rmMedia(L.img); }
  else if (b.removeImage === true) { db.prepare('UPDATE limited_gifts SET img=? WHERE id=?').run('', id); rmMedia(L.img); }
  res.json({ item: limView(db.prepare('SELECT * FROM limited_gifts WHERE id=?').get(id)) });
});
app.get('/api/admin/ton', adm, (_, res) => res.json({ ton: tonView(),
  history: db.prepare('SELECT rate, created_at at FROM gram_history ORDER BY id DESC LIMIT 20').all() }));
app.post('/api/admin/ton', adm, limit(30), async (req, res) => {   // «به‌روزرسانی همین حالا» از قیمت زنده
  await tonTick();
  res.json({ ton: tonView(), history: db.prepare('SELECT rate, created_at at FROM gram_history ORDER BY id DESC LIMIT 20').all() });
});
app.get('/api/admin/channels', adm, (req, res) => {
  const q = String(req.query.q || '').trim().replace(/^@/, '').replace(/[\\%_]/g, '\\$&'), like = `%${q}%`;
  const rows = db.prepare(`SELECT c.*, u.username owner, (SELECT COUNT(*) FROM channel_subs WHERE channel_id=c.id) subs FROM channels c
    LEFT JOIN users u ON u.id=c.owner_id
    WHERE ?='' OR c.handle LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\'
    ORDER BY (c.pinned>0) DESC, c.pinned DESC, (c.sponsored>0) DESC, c.id DESC LIMIT 50`).all(q, like, like, like);
  res.json({ channels: rows.map(c => ({ id: c.id, title: c.title, handle: c.handle, owner: c.owner || '—', subs: c.subs, photo: mediaUrl(c.photo),
    pinned: !!c.pinned, sponsored: !!c.sponsored, level: chLook(c).level })) });
});
app.post('/api/admin/channels/:id', adm, (req, res) => {
  const c = getCh(req.params.id);
  if (!c) return res.status(404).json({ error: 'کانال پیدا نشد' });
  if (typeof req.body.pinned === 'boolean') db.prepare('UPDATE channels SET pinned=? WHERE id=?').run(req.body.pinned ? Date.now() : 0, c.id);
  if (typeof req.body.sponsored === 'boolean') db.prepare('UPDATE channels SET sponsored=? WHERE id=?').run(+req.body.sponsored, c.id);
  io.emit('chpromo', {});
  res.json({ ok: true });
});
app.get('/api/admin/check', adm, (_, res) => res.json({ ok: true }));
app.post('/api/admin/logout', (_, res) => { res.clearCookie('adm'); res.json({ ok: true }); });
app.get('/api/admin/users', adm, (req, res) => {
  const q = String(req.query.q || '').trim().replace(/^@/, '').replace(/[\\%_]/g, '\\$&');
  const rows = db.prepare(`SELECT * FROM users WHERE username LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 100`).all(`%${q}%`);
  const cnt = (w, ...a) => db.prepare('SELECT COUNT(*) n FROM users' + (w ? ' WHERE ' + w : '')).get(...a).n;
  res.json({ users: rows.map(full), total: cnt(), persistent: PERSISTENT,
    stats: { online: online.size, premium: cnt('premium=1 OR premium_until>?', Date.now()), banned: cnt('banned=1'), legacy: cnt("pass_hash=''") } });
});
app.post('/api/admin/users/:id', adm, (req, res) => {
  const id = +req.params.id, b = req.body || {};
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) return res.status(404).json({ error: 'not found' });
  if (typeof b.banned === 'boolean') db.prepare('UPDATE users SET banned=? WHERE id=?').run(+b.banned, id);
  if (typeof b.premium === 'boolean') db.prepare('UPDATE users SET premium=? WHERE id=?').run(+b.premium, id);
  if (Number.isInteger(b.stars) && Math.abs(b.stars) <= 1e9) db.prepare('UPDATE users SET stars=MAX(0, stars+?) WHERE id=?').run(b.stars, id);
  if (typeof b.tag === 'string' && (b.tag === '' || USER_TAGS[b.tag])) db.prepare('UPDATE users SET admin_tag=? WHERE id=?').run(b.tag, id);
  const n = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (n.banned) io.in('u:' + id).disconnectSockets(true);
  else io.to('u:' + id).emit('account', { premium: isPrem(n), stars: n.stars });
  res.json({ user: full(n) });
});

app.delete('/api/admin/users/:id', adm, (req, res) => {
  const id = +req.params.id, u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const files = new Set([u.photo]);
  db.transaction(() => {
    // کانال‌های این کاربر: پست‌ها، ری‌اکشن‌ها، عضوها، بوست‌ها و هدیه‌های کانال
    for (const c of db.prepare('SELECT id, photo, bg_img FROM channels WHERE owner_id=?').all(id)) {
      files.add(c.photo); files.add(c.bg_img);
      for (const e of db.prepare('SELECT img FROM channel_emojis WHERE channel_id=?').all(c.id)) files.add(e.img);
      db.prepare('DELETE FROM channel_emojis WHERE channel_id=?').run(c.id);
      for (const p of db.prepare('SELECT id, img FROM posts WHERE channel_id=?').all(c.id)) {
        files.add(p.img);
        db.prepare('DELETE FROM reactions WHERE post_id=?').run(p.id);
      }
      db.prepare('DELETE FROM posts WHERE channel_id=?').run(c.id);
      db.prepare('DELETE FROM channel_subs WHERE channel_id=?').run(c.id);
      db.prepare('DELETE FROM boosts WHERE channel_id=?').run(c.id);
      db.prepare('DELETE FROM gifts WHERE channel_id=?').run(c.id);
      db.prepare('DELETE FROM channels WHERE id=?').run(c.id);
    }
    // گفتگوها و هدیه‌های دریافتی
    for (const m of db.prepare('SELECT img FROM messages WHERE sender_id=? OR receiver_id=?').all(id, id)) files.add(m.img);
    db.prepare('DELETE FROM messages WHERE sender_id=? OR receiver_id=?').run(id, id);
    db.prepare('DELETE FROM gifts WHERE receiver_id=?').run(id);
    // بقیه‌ی ردپا
    db.prepare('DELETE FROM reactions WHERE user_id=?').run(id);
    db.prepare('DELETE FROM boosts WHERE user_id=?').run(id);
    db.prepare('DELETE FROM channel_subs WHERE user_id=?').run(id);
    db.prepare('DELETE FROM blocks WHERE blocker_id=? OR blocked_id=?').run(id, id);
    db.prepare('DELETE FROM chat_clear WHERE user_id=? OR other_id=?').run(id, id);
    db.prepare('DELETE FROM users WHERE id=?').run(id);
  })();
  files.forEach(rmMedia);
  online.delete(id);
  io.in('u:' + id).disconnectSockets(true);
  io.emit('chpromo', {});
  res.json({ ok: true });
});

io.use((s, next) => {
  const raw = cookie.parse(s.handshake.headers.cookie || '').uid;
  const id = raw && cookieParser.signedCookie(raw, SECRET);
  const u = id && db.prepare('SELECT * FROM users WHERE id=?').get(+id);
  if (!u || u.banned) return next(new Error('unauthorized'));
  s.uid = u.id; next();
});
/* ---- حذف پیام و گروه‌ها ---- */
db.exec(`CREATE TABLE IF NOT EXISTS msg_hidden(user_id INTEGER NOT NULL, msg_id INTEGER NOT NULL, PRIMARY KEY(user_id, msg_id));
CREATE TABLE IF NOT EXISTS chat_groups(id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS group_members(group_id INTEGER NOT NULL, user_id INTEGER NOT NULL, joined_at INTEGER NOT NULL, last_read INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(group_id, user_id));
CREATE TABLE IF NOT EXISTS group_msgs(id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, sender_id INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, reply_to INTEGER);
CREATE INDEX IF NOT EXISTS idx_gm ON group_msgs(group_id, id);`);

// حذف پیام خصوصی: فرستنده «برای همه» (?all=1)، هر دو طرف «فقط برای من»
app.delete('/api/messages/:id', auth, limit(120), (req, res) => {
  const me = req.user.id, id = +req.params.id;
  const m = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
  if (!m || (m.sender_id !== me && m.receiver_id !== me)) return res.status(404).json({ error: 'پیام پیدا نشد' });
  if (m.gift_id || m.special) return res.status(400).json({ error: 'پیام هدیه قابل حذف نیست' });
  if (req.query.all === '1') {
    if (m.sender_id !== me) return res.status(403).json({ error: 'فقط فرستنده می‌تواند برای همه حذف کند' });
    db.prepare('DELETE FROM messages WHERE id=?').run(id); db.prepare("DELETE FROM msg_rx WHERE scope='d' AND msg_id=?").run(id);
    io.to('u:' + m.sender_id).to('u:' + m.receiver_id).emit('msgdel', { id });
  } else {
    db.prepare('INSERT OR IGNORE INTO msg_hidden(user_id,msg_id) VALUES(?,?)').run(me, id);
    io.to('u:' + me).emit('msgdel', { id });
  }
  res.json({ ok: true });
});

const GMAX = 200;
const gMember = (g, u) => !!db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(g, u);
const gGet = (id, uid) => { const g = db.prepare('SELECT * FROM chat_groups WHERE id=?').get(+id); return g && gMember(g.id, uid) ? g : null; };
const gMembers = id => db.prepare('SELECT u.* FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=? ORDER BY gm.joined_at, u.id').all(id).map(u => ({ ...pub(u), online: online.has(u.id) }));
const gInfo = g => ({ id: g.id, title: g.title, owner: g.owner_id, members: gMembers(g.id) });
const gMsg = m => { const u = db.prepare('SELECT id,name,username FROM users WHERE id=?').get(m.sender_id);
  const r = m.reply_to ? db.prepare('SELECT id,sender_id,body FROM group_msgs WHERE id=?').get(m.reply_to) : null;
  return { id: m.id, groupId: m.group_id, from: m.sender_id, sender: u || { id: 0, name: '؟', username: '' }, body: m.body, at: m.created_at, rx: rxList('g', m.id),
    reply: r ? { id: r.id, from: r.sender_id, body: String(r.body).slice(0, 120) } : null }; };
const gTouch = (ids, d) => ids.forEach(u => io.to('u:' + u).emit('gchange', d));
const gDrop = id => { db.prepare('DELETE FROM group_msgs WHERE group_id=?').run(id); db.prepare('DELETE FROM group_members WHERE group_id=?').run(id); db.prepare('DELETE FROM chat_groups WHERE id=?').run(id); };
const gIds = id => db.prepare('SELECT user_id FROM group_members WHERE group_id=? ORDER BY joined_at, user_id').all(id).map(r => r.user_id);

app.get('/api/groups', auth, (req, res) => {
  const me = req.user.id;
  const rows = db.prepare('SELECT g.*, gm.last_read FROM chat_groups g JOIN group_members gm ON gm.group_id=g.id WHERE gm.user_id=?').all(me);
  const out = rows.map(g => {
    const l = db.prepare('SELECT m.*, u.name uname FROM group_msgs m LEFT JOIN users u ON u.id=m.sender_id WHERE m.group_id=? ORDER BY m.id DESC LIMIT 1').get(g.id);
    return { id: g.id, title: g.title, owner: g.owner_id, members: db.prepare('SELECT COUNT(*) c FROM group_members WHERE group_id=?').get(g.id).c,
      unread: db.prepare('SELECT COUNT(*) c FROM group_msgs WHERE group_id=? AND id>? AND sender_id!=?').get(g.id, g.last_read, me).c,
      last: l ? { body: String(l.body).slice(0, 80), at: l.created_at, from: l.sender_id, name: l.uname || '' } : null, sort: l ? l.created_at : g.created_at };
  }).sort((a, b) => b.sort - a.sort);
  res.json({ groups: out });
});
app.post('/api/groups', auth, limit(20), (req, res) => {
  const me = req.user.id, title = String(req.body.title || '').trim().slice(0, 60);
  if (!title) return res.status(400).json({ error: 'نام گروه را بنویسید' });
  const names = [...new Set((Array.isArray(req.body.members) ? req.body.members : []).map(x => String(x).replace(/^@/, '').trim()).filter(Boolean))].slice(0, GMAX);
  const ids = [];
  for (const n of names) {
    const u = db.prepare('SELECT id FROM users WHERE username=? AND banned=0').get(n);
    if (!u) return res.status(400).json({ error: `کاربر @${n} پیدا نشد` });
    if (u.id !== me && !ids.includes(u.id)) ids.push(u.id);
  }
  if (!ids.length) return res.status(400).json({ error: 'حداقل یک عضو دیگر اضافه کنید' });
  if (db.prepare('SELECT COUNT(*) c FROM chat_groups WHERE owner_id=?').get(me).c >= 20) return res.status(400).json({ error: 'حداکثر ۲۰ گروه می‌توانید بسازید' });
  const t = Date.now(), id = Number(db.prepare('INSERT INTO chat_groups(owner_id,title,created_at) VALUES(?,?,?)').run(me, title, t).lastInsertRowid);
  for (const u of [me, ...ids]) { db.prepare('INSERT INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)').run(id, u, t); io.in('u:' + u).socketsJoin('g:' + id); }
  gTouch([me, ...ids], { id });
  res.json({ id });
});
app.get('/api/groups/:id', auth, (req, res) => { const g = gGet(req.params.id, req.user.id); if (!g) return res.status(404).json({ error: 'گروه پیدا نشد' }); res.json({ group: gInfo(g) }); });
app.get('/api/groups/:id/messages', auth, (req, res) => {
  const g = gGet(req.params.id, req.user.id); if (!g) return res.status(404).json({ error: 'گروه پیدا نشد' });
  const before = +req.query.before || 9e15;
  const rows = db.prepare('SELECT * FROM group_msgs WHERE group_id=? AND id<? ORDER BY id DESC LIMIT 60').all(g.id, before).reverse();
  res.json({ group: gInfo(g), messages: rows.map(gMsg) });
});
app.post('/api/groups/:id/messages', auth, limit(120), (req, res) => {
  const me = req.user.id, g = gGet(req.params.id, me); if (!g) return res.status(404).json({ error: 'گروه پیدا نشد' });
  const body = stripPe(req.user, String(req.body.body || '').trim().slice(0, LIM(req.user).msg)).trim();
  if (!body) return res.status(400).json({ error: 'پیام خالی است' });
  const rp = +req.body.replyTo && db.prepare('SELECT 1 FROM group_msgs WHERE id=? AND group_id=?').get(+req.body.replyTo, g.id) ? +req.body.replyTo : null;
  const r = db.prepare('INSERT INTO group_msgs(group_id,sender_id,body,created_at,reply_to) VALUES(?,?,?,?,?)').run(g.id, me, body, Date.now(), rp);
  io.to('g:' + g.id).emit('gmessage', gMsg(db.prepare('SELECT * FROM group_msgs WHERE id=?').get(r.lastInsertRowid)));
  res.json({ ok: true });
});
app.delete('/api/groups/:id/messages/:mid', auth, limit(120), (req, res) => {
  const me = req.user.id, g = gGet(req.params.id, me); if (!g) return res.status(404).json({ error: 'گروه پیدا نشد' });
  const m = db.prepare('SELECT * FROM group_msgs WHERE id=? AND group_id=?').get(+req.params.mid, g.id);
  if (!m) return res.status(404).json({ error: 'پیام پیدا نشد' });
  if (m.sender_id !== me && g.owner_id !== me) return res.status(403).json({ error: 'اجازه‌ی حذف این پیام را ندارید' });
  db.prepare('DELETE FROM group_msgs WHERE id=?').run(m.id); db.prepare("DELETE FROM msg_rx WHERE scope='g' AND msg_id=?").run(m.id);
  io.to('g:' + g.id).emit('gmsgdel', { groupId: g.id, id: m.id });
  res.json({ ok: true });
});
app.post('/api/groups/:id/read', auth, (req, res) => {
  const me = req.user.id, g = gGet(req.params.id, me); if (!g) return res.status(404).json({ error: 'گروه پیدا نشد' });
  db.prepare('UPDATE group_members SET last_read=COALESCE((SELECT MAX(id) FROM group_msgs WHERE group_id=?),0) WHERE group_id=? AND user_id=?').run(g.id, g.id, me);
  res.json({ ok: true });
});
app.patch('/api/groups/:id', auth, limit(60), (req, res) => {
  const me = req.user.id, g = gGet(req.params.id, me); if (!g) return res.status(404).json({ error: 'گروه پیدا نشد' });
  if (g.owner_id !== me) return res.status(403).json({ error: 'فقط سازنده‌ی گروه می‌تواند نام را عوض کند' });
  const title = String(req.body.title || '').trim().slice(0, 60); if (!title) return res.status(400).json({ error: 'نام گروه را بنویسید' });
  db.prepare('UPDATE chat_groups SET title=? WHERE id=?').run(title, g.id);
  gTouch(gIds(g.id), { id: g.id }); res.json({ ok: true });
});
app.post('/api/groups/:id/members', auth, limit(60), (req, res) => {
  const me = req.user.id, g = gGet(req.params.id, me); if (!g) return res.status(404).json({ error: 'گروه پیدا نشد' });
  if (g.owner_id !== me) return res.status(403).json({ error: 'فقط سازنده‌ی گروه می‌تواند عضو اضافه کند' });
  const n = String(req.body.username || '').replace(/^@/, '').trim();
  const u = db.prepare('SELECT id FROM users WHERE username=? AND banned=0').get(n);
  if (!u) return res.status(400).json({ error: 'کاربر پیدا نشد' });
  if (gMember(g.id, u.id)) return res.status(400).json({ error: 'این کاربر عضو گروه است' });
  if (gIds(g.id).length >= GMAX) return res.status(400).json({ error: 'گروه پر است' });
  db.prepare('INSERT INTO group_members(group_id,user_id,joined_at,last_read) VALUES(?,?,?,?)').run(g.id, u.id, Date.now(), db.prepare('SELECT COALESCE(MAX(id),0) m FROM group_msgs WHERE group_id=?').get(g.id).m);
  io.in('u:' + u.id).socketsJoin('g:' + g.id);
  gTouch(gIds(g.id), { id: g.id }); res.json({ ok: true });
});
app.delete('/api/groups/:id/members/:uid', auth, limit(60), (req, res) => {
  const me = req.user.id, g = gGet(req.params.id, me), uid = +req.params.uid; if (!g) return res.status(404).json({ error: 'گروه پیدا نشد' });
  if (uid !== me && g.owner_id !== me) return res.status(403).json({ error: 'اجازه‌ی حذف عضو را ندارید' });
  if (!gMember(g.id, uid)) return res.status(404).json({ error: 'عضو پیدا نشد' });
  const all = gIds(g.id);
  db.prepare('DELETE FROM group_members WHERE group_id=? AND user_id=?').run(g.id, uid);
  io.in('u:' + uid).socketsLeave('g:' + g.id);
  const rest = all.filter(x => x !== uid);
  if (!rest.length) gDrop(g.id); else if (uid === g.owner_id) db.prepare('UPDATE chat_groups SET owner_id=? WHERE id=?').run(rest[0], g.id);
  gTouch(all, { id: g.id, removed: uid }); res.json({ ok: true });
});
app.delete('/api/groups/:id', auth, limit(30), (req, res) => {
  const me = req.user.id, g = gGet(req.params.id, me); if (!g) return res.status(404).json({ error: 'گروه پیدا نشد' });
  if (g.owner_id !== me) return res.status(403).json({ error: 'فقط سازنده‌ی گروه می‌تواند آن را حذف کند' });
  const all = gIds(g.id); gDrop(g.id);
  all.forEach(u => io.in('u:' + u).socketsLeave('g:' + g.id));
  gTouch(all, { id: g.id, deleted: true }); res.json({ ok: true });
});

/* ---- ایموجی پریمیوم (عکسی، ساخته‌ی ادمین) و ری‌اکشن پیام‌ها ---- */
db.exec(`CREATE TABLE IF NOT EXISTS premium_emojis(id INTEGER PRIMARY KEY, img TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS msg_rx(scope TEXT NOT NULL, msg_id INTEGER NOT NULL, user_id INTEGER NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(scope, msg_id, user_id, kind));`);
const peList = () => db.prepare('SELECT id, img FROM premium_emojis ORDER BY id').all().map(e => ({ id: e.id, url: mediaUrl(e.img) }));
const pemojiOk = k => /^pe:\d+$/.test(k) && !!db.prepare('SELECT 1 FROM premium_emojis WHERE id=?').get(+k.slice(3));
const stripPe = (u, t) => t.replace(/:pe(\d+):/g, (m, i) => isPrem(u) && pemojiOk('pe:' + i) ? m : '');
const saveEmoji = (dataUrl, base, maxBytes) => {
  const m = /^data:image\/(png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '')); if (!m) return null;
  const buf = Buffer.from(m[2], 'base64'); if (buf.length < 100 || buf.length > maxBytes) return null;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  const webp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  if (m[1] === 'png' ? !png : !webp) return null;
  const name = base + '.' + m[1]; fs.writeFileSync(path.join(MEDIA, name), buf); return name;
};
app.get('/api/pemojis', auth, (_, res) => res.json({ emojis: peList() }));
app.get('/api/admin/pemojis', adm, (_, res) => res.json({ emojis: peList() }));
app.post('/api/admin/pemojis', adm, limit(60), (req, res) => {
  const f = saveEmoji(req.body.image, `pe-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, 200e3);
  if (!f) return res.status(400).json({ error: 'عکس معتبر نیست (PNG یا WebP، حداکثر ۲۰۰ کیلوبایت)' });
  db.prepare('INSERT INTO premium_emojis(img,created_at) VALUES(?,?)').run(f, Date.now());
  io.emit('pemojis', { emojis: peList() }); res.json({ emojis: peList() });
});
app.delete('/api/admin/pemojis/:id', adm, (req, res) => {
  const e = db.prepare('SELECT * FROM premium_emojis WHERE id=?').get(+req.params.id);
  if (!e) return res.status(404).json({ error: 'پیدا نشد' });
  rmMedia(e.img); db.prepare('DELETE FROM premium_emojis WHERE id=?').run(e.id);
  const k = 'pe:' + e.id; db.prepare('DELETE FROM reactions WHERE kind=?').run(k); db.prepare('DELETE FROM msg_rx WHERE kind=?').run(k);
  io.emit('pemojis', { emojis: peList() }); res.json({ emojis: peList() });
});
const rxList = (scope, id) => db.prepare('SELECT user_id u, kind k FROM msg_rx WHERE scope=? AND msg_id=?').all(scope, id).map(r => [r.u, r.k]);
const rxToggle = (scope, id, uid, k) => {
  if (db.prepare('DELETE FROM msg_rx WHERE scope=? AND msg_id=? AND user_id=? AND kind=?').run(scope, id, uid, k).changes) return;
  if (db.prepare('SELECT COUNT(*) c FROM msg_rx WHERE scope=? AND msg_id=? AND user_id=?').get(scope, id, uid).c >= 6) return;
  db.prepare('INSERT INTO msg_rx(scope,msg_id,user_id,kind) VALUES(?,?,?,?)').run(scope, id, uid, k);
};
const rxCheck = (u, k, res) => {
  if (FREE_KINDS.includes(k)) return true;
  if (/^pe:\d+$/.test(k)) { if (!isPrem(u)) { res.status(403).json({ error: 'این ایموجی ویژه‌ی کاربران پریمیوم است' }); return false; } if (pemojiOk(k)) return true; }
  res.status(400).json({ error: 'ری‌اکشن نامعتبر' }); return false;
};
app.post('/api/messages/:id/react', auth, limit(240), (req, res) => {
  const me = req.user.id, id = +req.params.id, k = String(req.body.kind || '');
  const m = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
  if (!m || m.gift_id || m.special || (m.sender_id !== me && m.receiver_id !== me)) return res.status(404).json({ error: 'پیام پیدا نشد' });
  if (!rxCheck(req.user, k, res)) return;
  rxToggle('d', id, me, k); const rx = rxList('d', id);
  io.to('u:' + m.sender_id).to('u:' + m.receiver_id).emit('mrx', { scope: 'd', id, rx }); res.json({ rx });
});
app.post('/api/groups/:id/messages/:mid/react', auth, limit(240), (req, res) => {
  const me = req.user.id, g = gGet(req.params.id, me), k = String(req.body.kind || ''); if (!g) return res.status(404).json({ error: 'گروه پیدا نشد' });
  const m = db.prepare('SELECT id FROM group_msgs WHERE id=? AND group_id=?').get(+req.params.mid, g.id); if (!m) return res.status(404).json({ error: 'پیام پیدا نشد' });
  if (!rxCheck(req.user, k, res)) return;
  rxToggle('g', m.id, me, k); const rx = rxList('g', m.id);
  io.to('g:' + g.id).emit('mrx', { scope: 'g', id: m.id, groupId: g.id, rx }); res.json({ rx });
});

/* ---- بازی‌ها: انفجار (Crash) ----
   راند مشترک برای همه: ۷ ثانیه شرط‌بندی ← راکت بالا می‌رود (ضریب نمایی) ← در نقطه‌ی تصادفیِ مخفی منفجر می‌شود.
   راند فقط وقتی شروع می‌شود که اولین نفر شرط ببندد (تا آن موقع فاز idle است و هیچ تایمری روی سرور نیست)؛
   بعد از پایان هر راند دوباره idle می‌شود تا اولین شرط بعدی.
   نقطه‌ی انفجار فقط سمت سرور ساخته می‌شود و تا لحظه‌ی انفجار به هیچ کلاینتی فرستاده نمی‌شود.
   EDGE = سهم خانه (۴٪)، MIN_BET = حداقل شرط (⭐)؛ MAX_BET عملاً بی‌نهایت است و سقف شرط فقط موجودی استارز کاربر است، MAX_X = سقف ضریب، GROWTH = سرعت رشد. */
const CR = { EDGE: 0.04, MIN_BET: 1, MAX_BET: Number.MAX_SAFE_INTEGER, MAX_X: 100, GROWTH: 0.09, BET_MS: 7000, GAP_MS: 4000 };
db.exec(`CREATE TABLE IF NOT EXISTS crash_rounds(id INTEGER PRIMARY KEY, crash_x REAL NOT NULL DEFAULT 0, started_at INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS crash_bets(round_id INTEGER NOT NULL, user_id INTEGER NOT NULL, bet INTEGER NOT NULL, auto_x REAL NOT NULL DEFAULT 0, cash_x REAL, payout INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(round_id, user_id));`);
if (!db.prepare('PRAGMA table_info(crash_bets)').all().some(x => x.name === 'gift_id')) db.exec('ALTER TABLE crash_bets ADD COLUMN gift_id INTEGER');
// اگر سرور وسط یک راند خاموش شده بود، شرط‌های برداشت‌نشده‌ی آن راند به صاحبانشان برمی‌گردد (NFTها فقط از قفل درمی‌آیند)
db.prepare('UPDATE gifts SET staked=0 WHERE staked=1').run();
for (const r of db.prepare('SELECT id FROM crash_rounds WHERE done=0').all()) {
  for (const b of db.prepare('SELECT user_id, bet, gift_id FROM crash_bets WHERE round_id=? AND cash_x IS NULL').all(r.id))
    if (!b.gift_id) db.prepare('UPDATE users SET stars=stars+? WHERE id=?').run(b.bet, b.user_id);
  db.prepare('UPDATE crash_rounds SET done=1, crash_x=0 WHERE id=?').run(r.id);
}
const crX = ms => Math.floor(100 * Math.exp(CR.GROWTH * ms / 1000)) / 100;
const crMs = x => Math.log(x) / CR.GROWTH * 1000;
const crRand = () => { const r = crypto.randomInt(0, 2 ** 32) / 2 ** 32; return Math.min(CR.MAX_X, Math.max(1, Math.floor(100 * (1 - CR.EDGE) / (1 - r)) / 100)); };
const crHist = db.prepare('SELECT crash_x x FROM crash_rounds WHERE done=1 AND crash_x>=1 ORDER BY id DESC LIMIT 25').all().map(r => r.x);
let CRS = { id: 0, phase: 'end', crash: 1, endsAt: 0, startedAt: 0, bets: new Map() };
const crList = () => [...CRS.bets.values()].sort((a, b) => b.bet - a.bet).slice(0, 60).map(b => ({ id: b.id, name: b.name, bet: b.bet, x: b.x, pay: b.payout, nft: b.nft || '' }));
const crSnap = uid => {
  const m = CRS.bets.get(uid);
  return { phase: CRS.phase, id: CRS.id, now: Date.now(), endsAt: CRS.endsAt, startedAt: CRS.startedAt, growth: CR.GROWTH, hist: crHist, bets: crList(),
    mine: m ? { bet: m.bet, auto: m.auto, x: m.x, pay: m.payout, nft: !!m.gift } : null, min: CR.MIN_BET, max: CR.MAX_BET, maxX: CR.MAX_X, stars: starsOf(uid),
    ...(CRS.phase === 'end' ? { crashX: CRS.crash } : {}) };
};
const crEmit = d => io.to('crash').emit('crash', d);
function crIdle() {
  CRS = { id: 0, phase: 'idle', crash: 1, endsAt: 0, startedAt: 0, bets: new Map() };
  crEmit({ t: 'idle', now: Date.now(), hist: crHist });
}
function crBetting() {
  const id = db.prepare('INSERT INTO crash_rounds(crash_x, started_at) VALUES(0, 0)').run().lastInsertRowid;
  CRS = { id, phase: 'bet', crash: crRand(), endsAt: Date.now() + CR.BET_MS, startedAt: 0, bets: new Map() };
  crEmit({ t: 'bet', id, now: Date.now(), endsAt: CRS.endsAt, hist: crHist });
  setTimeout(crRun, CR.BET_MS);
}
function crCash(uid, x, rid) {
  const b = CRS.bets.get(uid);
  if (!b || b.x || CRS.phase !== 'run' || CRS.id !== rid) return null;
  if (b.gift) {   // شرط با NFT: ارزش NFT ضرب در ضریب می‌شود (استارز پرداخت نمی‌شود) و از قفل درمی‌آید
    const nv = Math.min(1e12, Math.floor(b.bet * x + 1e-9));
    b.x = x; b.payout = nv - b.bet;
    db.prepare('UPDATE crash_bets SET cash_x=?, payout=? WHERE round_id=? AND user_id=?').run(x, b.payout, rid, uid);
    db.prepare('UPDATE gifts SET value=?, staked=0 WHERE id=?').run(nv, b.gift);
    crEmit({ t: 'cash', id: uid, x, pay: b.payout, nft: true });
    return b;
  }
  const pay = Math.floor(b.bet * x + 1e-9);
  b.x = x; b.payout = pay;
  db.prepare('UPDATE crash_bets SET cash_x=?, payout=? WHERE round_id=? AND user_id=?').run(x, pay, rid, uid);
  db.prepare('UPDATE users SET stars=stars+? WHERE id=?').run(pay, uid);
  io.to('u:' + uid).emit('account', { stars: starsOf(uid) });
  crEmit({ t: 'cash', id: uid, x, pay });
  return b;
}
function crRun() {
  const rid = CRS.id;
  if (!CRS.bets.size) {   // هیچ‌کس شرط نبسته (مثلاً شرط ناموفق بود) ← راند لغو و برگشت به حالت انتظار
    db.prepare('UPDATE crash_rounds SET done=1, crash_x=0 WHERE id=?').run(rid);
    return crIdle();
  }
  CRS.phase = 'run'; CRS.startedAt = Date.now();
  for (const b of CRS.bets.values()) if (b.auto && b.auto < CRS.crash) setTimeout(() => crCash(b.id, b.auto, rid), crMs(b.auto));
  setTimeout(crEnd, crMs(CRS.crash));
  crEmit({ t: 'run', id: rid, now: Date.now(), startedAt: CRS.startedAt, growth: CR.GROWTH });
}
function crEnd() {
  const x = CRS.crash;
  CRS.phase = 'end';
  db.prepare('UPDATE crash_rounds SET crash_x=?, started_at=?, done=1 WHERE id=?').run(x, CRS.startedAt, CRS.id);
  for (const b of CRS.bets.values()) if (b.gift && !b.x) {   // راکت منفجر شد ← NFTِ برداشت‌نشده می‌سوزد
    db.transaction(() => {
      db.prepare('UPDATE gifts SET converted=1, staked=0, value=0 WHERE id=?').run(b.gift);
      db.prepare('UPDATE users SET profile_gift=0 WHERE id=? AND profile_gift=?').run(b.id, b.gift);
    })();
    io.to('u:' + b.id).emit('giftupdate', { id: b.gift, converted: true });
  }
  crHist.unshift(x); crHist.length = Math.min(crHist.length, 25);
  crEmit({ t: 'end', id: CRS.id, x, hist: crHist, bets: crList() });
  setTimeout(crIdle, CR.GAP_MS);
}
app.get('/api/crash', auth, (req, res) => res.json(crSnap(req.user.id)));
app.post('/api/crash/bet', auth, limit(300), (req, res) => {
  const uid = req.user.id, giftId = +req.body.gift || 0;
  let amount = +req.body.amount;
  let auto = req.body.auto ? Math.round(+req.body.auto * 100) / 100 : 0;
  if (CRS.phase !== 'idle' && (CRS.phase !== 'bet' || Date.now() >= CRS.endsAt)) return res.status(409).json({ error: 'شرط‌بندی بسته است؛ راند بعدی را منتظر بمانید' });
  if (!giftId && (!Number.isSafeInteger(amount) || amount < CR.MIN_BET)) return res.status(400).json({ error: `شرط باید یک عدد صحیح و حداقل ${CR.MIN_BET} ⭐ باشد` });
  if (auto && !(auto >= 1.01 && auto <= CR.MAX_X)) return res.status(400).json({ error: `برداشت خودکار باید بین 1.01 تا ${CR.MAX_X} باشد` });
  if (CRS.bets.has(uid)) return res.status(409).json({ error: 'در این راند شرط بسته‌اید' });
  let G = null, nftLabel = '';
  if (giftId) {   // شرط با NFT (هدیه‌ی لیمیتدِ خودِ کاربر)
    G = db.prepare('SELECT * FROM gifts WHERE id=? AND receiver_id=? AND channel_id IS NULL AND lim_id IS NOT NULL AND converted=0').get(giftId, uid);
    if (!G) return res.status(404).json({ error: 'این NFT پیدا نشد' });
    if (G.staked) return res.status(409).json({ error: 'این NFT الان در بازی است' });
    if (G.listed) return res.status(409).json({ error: 'این NFT در پورتال برای فروش گذاشته شده است' });
    const L = db.prepare('SELECT name, emoji FROM limited_gifts WHERE id=?').get(G.lim_id) || {};
    nftLabel = `${L.emoji || '💠'} ${L.name || 'NFT'} #${G.serial}`;
    amount = valueOf(G);   // «مبلغ شرط» = ارزش فعلی NFT
  }
  if (CRS.phase === 'idle') {   // اولین شرط ← تایمر شرط‌بندی همین الان شروع می‌شود
    if (!G && starsOf(uid) < amount) return res.status(402).json({ error: 'استارز شما کافی نیست' });
    crBetting();
  }
  try {
    db.transaction(() => {
      if (G) { if (!db.prepare('UPDATE gifts SET staked=1 WHERE id=? AND staked=0 AND listed=0 AND converted=0 AND receiver_id=?').run(G.id, uid).changes) throw new Error('nft'); }
      else if (!db.prepare('UPDATE users SET stars=stars-? WHERE id=? AND stars>=?').run(amount, uid, amount).changes) throw new Error('stars');
      db.prepare('INSERT INTO crash_bets(round_id, user_id, bet, auto_x, gift_id) VALUES(?,?,?,?,?)').run(CRS.id, uid, amount, auto, G ? G.id : null);
    })();
  } catch (e) { return res.status(G ? 409 : 402).json({ error: G ? 'این NFT الان در دسترس نیست' : 'استارز شما کافی نیست' }); }
  CRS.bets.set(uid, { id: uid, name: req.user.name, bet: amount, auto, x: 0, payout: 0, gift: G ? G.id : 0, nft: nftLabel });
  io.to('u:' + uid).emit('account', { stars: starsOf(uid) });
  crEmit({ t: 'bets', bets: crList() });
  res.json({ ok: true, id: CRS.id, stars: starsOf(uid), bet: amount, nft: !!G });
});
app.post('/api/crash/cashout', auth, limit(900), (req, res) => {
  const uid = req.user.id, b = CRS.bets.get(uid);
  if (!b) return res.status(404).json({ error: 'در این راند شرط نبسته‌اید' });
  if (b.x) return res.status(409).json({ error: 'قبلاً برداشت کرده‌اید' });
  if (CRS.phase === 'bet') return res.status(409).json({ error: 'راکت هنوز پرتاب نشده است' });
  const t = Date.now() - CRS.startedAt;
  if (CRS.phase !== 'run' || t >= crMs(CRS.crash)) return res.status(409).json({ error: 'دیر شد؛ راکت منفجر شد' });
  const x = Math.max(1, crX(t)), r = crCash(uid, x, CRS.id);
  if (!r) return res.status(409).json({ error: 'برداشت ممکن نیست' });
  res.json({ x, pay: r.payout, stars: starsOf(uid), nft: !!r.gift });
});
io.on('connection', s => {
  s.on('crash:join', () => s.join('crash'));
  s.on('crash:leave', () => s.leave('crash'));
});
crIdle();

/* ---- بازی‌ها: پوچ ⭐ (Mines) ----
   صفحه‌ی N خانه‌ای از ستاره؛ MINES تا از آن‌ها مین است. هر ستاره‌ی سالم ضریب را بالا می‌برد؛ هر لحظه می‌شود برداشت کرد،
   ولی اگر روی مین بزنید شرط می‌سوزد. جای مین‌ها فقط سمت سرور ساخته می‌شود و تا پایان بازی به کلاینت فرستاده نمی‌شود.
   ضریب = (۱ − EDGE) × احتمال‌های معکوس انتخاب‌های سالم پشت‌سرهم. */
const PC = { N: 25, MINES: 2, EDGE: 0.04, MIN_BET: 1, MAX_BET: 1000 };
db.exec(`CREATE TABLE IF NOT EXISTS pooch_games(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, bet INTEGER NOT NULL, mines TEXT NOT NULL, picks TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', payout INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS pooch_user ON pooch_games(user_id, status);`);
const pcMult = k => { if (!k) return 1; let m = 1 - PC.EDGE; for (let i = 0; i < k; i++) m *= (PC.N - i) / (PC.N - PC.MINES - i); return Math.max(1, Math.floor(m * 100) / 100); };
const pcView = g => {
  const picks = JSON.parse(g.picks), k = picks.length, done = g.status !== 'active';
  return { id: g.id, bet: g.bet, picks, status: g.status, payout: g.payout, mult: pcMult(k), cash: Math.floor(g.bet * pcMult(k) + 1e-9),
    next: k < PC.N - PC.MINES ? pcMult(k + 1) : null, ...(done ? { mines: JSON.parse(g.mines) } : {}) };
};
const pcActive = uid => db.prepare("SELECT * FROM pooch_games WHERE user_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(uid);
const pcPay = (uid, g, status, payout) => {
  db.transaction(() => {
    if (!db.prepare("UPDATE pooch_games SET status=?, payout=? WHERE id=? AND status='active'").run(status, payout, g.id).changes) throw new Error('done');
    if (payout) db.prepare('UPDATE users SET stars=stars+? WHERE id=?').run(payout, uid);
  })();
  io.to('u:' + uid).emit('account', { stars: starsOf(uid) });
};
app.get('/api/pooch', auth, (req, res) => {
  const uid = req.user.id, g = pcActive(uid);
  const hist = db.prepare("SELECT status, bet, payout, picks FROM pooch_games WHERE user_id=? AND status<>'active' ORDER BY id DESC LIMIT 20").all(uid)
    .map(r => ({ status: r.status, bet: r.bet, payout: r.payout, mult: r.status === 'won' ? pcMult(JSON.parse(r.picks).length) : 0 }));
  res.json({ cfg: { n: PC.N, mines: PC.MINES, min: PC.MIN_BET, max: PC.MAX_BET }, game: g ? pcView(g) : null, hist, stars: starsOf(uid) });
});
app.post('/api/pooch/start', auth, limit(300), (req, res) => {
  const uid = req.user.id, amount = +req.body.amount;
  if (!Number.isInteger(amount) || amount < PC.MIN_BET || amount > PC.MAX_BET) return res.status(400).json({ error: `شرط باید بین ${PC.MIN_BET} تا ${PC.MAX_BET} ⭐ باشد` });
  if (pcActive(uid)) return res.status(409).json({ error: 'یک بازی نیمه‌تمام دارید' });
  const cells = Array.from({ length: PC.N }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  const mines = cells.slice(0, PC.MINES).sort((a, b) => a - b);
  let id;
  try {
    db.transaction(() => {
      if (!db.prepare('UPDATE users SET stars=stars-? WHERE id=? AND stars>=?').run(amount, uid, amount).changes) throw new Error('stars');
      id = db.prepare('INSERT INTO pooch_games(user_id, bet, mines, created_at) VALUES(?,?,?,?)').run(uid, amount, JSON.stringify(mines), Date.now()).lastInsertRowid;
    })();
  } catch (e) { return res.status(402).json({ error: 'استارز شما کافی نیست' }); }
  io.to('u:' + uid).emit('account', { stars: starsOf(uid) });
  res.json({ game: pcView(db.prepare('SELECT * FROM pooch_games WHERE id=?').get(id)), stars: starsOf(uid) });
});
app.post('/api/pooch/pick', auth, limit(900), (req, res) => {
  const uid = req.user.id, cell = +req.body.cell, g = pcActive(uid);
  if (!g) return res.status(404).json({ error: 'بازی فعالی ندارید' });
  if (!Number.isInteger(cell) || cell < 0 || cell >= PC.N) return res.status(400).json({ error: 'خانه نامعتبر است' });
  const picks = JSON.parse(g.picks), mines = JSON.parse(g.mines);
  if (picks.includes(cell)) return res.status(409).json({ error: 'این خانه باز شده است' });
  if (mines.includes(cell)) {
    picks.push(cell);
    try { pcPay(uid, g, 'lost', 0); } catch (e) { return res.status(409).json({ error: 'بازی تمام شده است' }); }
    const lost = db.prepare('SELECT * FROM pooch_games WHERE id=?').get(g.id);
    return res.json({ boom: true, hit: cell, game: pcView(lost), stars: starsOf(uid) });
  }
  picks.push(cell); g.picks = JSON.stringify(picks);
  db.prepare('UPDATE pooch_games SET picks=? WHERE id=?').run(g.picks, g.id);
  if (picks.length >= PC.N - PC.MINES) {   // همه‌ی ستاره‌های سالم باز شد ← برداشت خودکار
    const pay = Math.floor(g.bet * pcMult(picks.length) + 1e-9);
    try { pcPay(uid, g, 'won', pay); } catch (e) { return res.status(409).json({ error: 'بازی تمام شده است' }); }
    return res.json({ game: pcView(db.prepare('SELECT * FROM pooch_games WHERE id=?').get(g.id)), stars: starsOf(uid) });
  }
  res.json({ game: pcView(g), stars: starsOf(uid) });
});
app.post('/api/pooch/cashout', auth, limit(600), (req, res) => {
  const uid = req.user.id, g = pcActive(uid);
  if (!g) return res.status(404).json({ error: 'بازی فعالی ندارید' });
  const k = JSON.parse(g.picks).length;
  if (k < 1) return res.status(409).json({ error: 'اول حداقل یک ستاره باز کنید' });
  try { pcPay(uid, g, 'won', Math.floor(g.bet * pcMult(k) + 1e-9)); } catch (e) { return res.status(409).json({ error: 'بازی تمام شده است' }); }
  res.json({ game: pcView(db.prepare('SELECT * FROM pooch_games WHERE id=?').get(g.id)), stars: starsOf(uid) });
});

io.on('connection', s => {
  const me = s.uid;
  s.join('u:' + me);
  for (const r of db.prepare('SELECT group_id FROM group_members WHERE user_id=?').all(me)) s.join('g:' + r.group_id);
  for (const r of db.prepare('SELECT channel_id FROM channel_subs WHERE user_id=?').all(me)) s.join('c:' + r.channel_id);
  s.on('watch', id => { if (db.prepare('SELECT 1 FROM channels WHERE id=?').get(+id)) s.join('c:' + +id); });
  online.set(me, (online.get(me) || 0) + 1);
  if (online.get(me) === 1) io.emit('presence', { id: me, online: true });

  s.on('send', (d, ack) => {
    const meU = db.prepare('SELECT * FROM users WHERE id=?').get(me), to = +d?.to, body = stripPe(meU, String(d?.body || '').trim().slice(0, LIM(meU).msg)).trim();
    if (!body || !to || to === me || !db.prepare('SELECT 1 FROM users WHERE id=? AND banned=0').get(to)) return ack?.({ ok: false });
    if (blockedEither(me, to)) return ack?.({ ok: false, blocked: blockedByMe(me, to) ? 'me' : 'them' });
    const r = db.prepare('INSERT INTO messages(sender_id,receiver_id,body,created_at,reply_to) VALUES(?,?,?,?,?)').run(me, to, body, Date.now(), okReply(d?.replyTo, me, to));
    io.to('u:' + me).to('u:' + to).emit('message', fmt(db.prepare('SELECT * FROM messages WHERE id=?').get(r.lastInsertRowid)));
    ack?.({ ok: true });
  });
  s.on('typing', d => { if (+d?.to) io.to('u:' + +d.to).emit('typing', { from: me }); });
  s.on('read', d => {
    const from = +d?.from;
    if (!from) return;
    const r = db.prepare('UPDATE messages SET read_at=? WHERE sender_id=? AND receiver_id=? AND read_at IS NULL').run(Date.now(), from, me);
    if (r.changes) io.to('u:' + from).to('u:' + me).emit('read', { by: me, from });
  });
  s.on('disconnect', () => {
    const n = (online.get(me) || 1) - 1;
    if (n > 0) return online.set(me, n);
    online.delete(me);
    const t = Date.now();
    db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(t, me);
    io.emit('presence', { id: me, online: false, lastSeen: t });
  });
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { db.close(); } catch (e) {} process.exit(0); });
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('NovinGram on :' + PORT));
