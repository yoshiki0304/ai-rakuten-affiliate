import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const required = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required secret: ${key}`);
}

const PRODUCTS_PATH = new URL('../data/products.json', import.meta.url);
const STATE_PATH = new URL('../data/x-state.json', import.meta.url);
const API_URL = 'https://api.x.com/2/tweets';

const enc = value => encodeURIComponent(String(value))
  .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function oauthHeader(method, url) {
  const oauth = {
    oauth_consumer_key: process.env.X_API_KEY,
    oauth_nonce: crypto.randomBytes(18).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: process.env.X_ACCESS_TOKEN,
    oauth_version: '1.0'
  };

  const normalized = Object.entries(oauth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join('&');

  const base = [method.toUpperCase(), enc(url), enc(normalized)].join('&');
  const key = `${enc(process.env.X_API_SECRET)}&${enc(process.env.X_ACCESS_TOKEN_SECRET)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');

  return 'OAuth ' + Object.entries(oauth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
    .join(', ');
}

async function readJson(url, fallback) {
  try {
    return JSON.parse(await fs.readFile(url, 'utf8'));
  } catch {
    return fallback;
  }
}

function todayJst() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function clean(s = '') {
  return String(s).replace(/\s+/g, ' ').trim();
}

function clip(s, max) {
  const chars = Array.from(clean(s));
  return chars.length <= max ? chars.join('') : chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

function chooseProduct(products, state) {
  const recent = new Set((state.postedItemCodes || []).slice(-24));
  const sorted = [...products].sort((a, b) => {
    const rankA = Number(a.globalRank || 999);
    const rankB = Number(b.globalRank || 999);
    return rankA - rankB;
  });
  return sorted.find(p => p.itemCode && p.affiliateUrl && !recent.has(p.itemCode))
    || sorted.find(p => p.itemCode && p.affiliateUrl);
}

function fallbackPost(p) {
  const rating = Number(p.reviewAverage || 0);
  const reviews = Number(p.reviewCount || 0);
  const title = clip(p.shortTitle || p.itemName, 38);
  const metric = rating && reviews
    ? `評価${rating.toFixed(2)}／レビュー${reviews.toLocaleString('ja-JP')}件`
    : '楽天市場の公開商品データから選定';
  return `PR｜${p.category || '暮らし'}の注目アイテム\n${title}\n${metric}\n楽天市場で詳細を見る↓`;
}

async function aiPost(p) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return fallbackPost(p);
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const prompt = `楽天アフィリエイト用のX投稿文を1本だけ作成してください。\n\n厳守事項:\n- 日本語。URLを除いて最大95文字程度。\n- 1行目は必ず「PR｜」から開始。\n- 商品データ以外の性能・効果・体験を捏造しない。\n- 最安、絶対、必ず、No.1など未検証の断定は禁止。\n- ハッシュタグ不要。\n- URLは出力しない。最後は「楽天市場で詳細を見る↓」で終える。\n- 文章だけ返す。\n\n商品データ:\n${JSON.stringify({category:p.category, title:p.shortTitle||p.itemName, price:p.itemPrice, reviewAverage:p.reviewAverage, reviewCount:p.reviewCount, summary:p.aiSummary})}`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.55}})
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const json = await res.json();
    const text = clean(json?.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '');
    if (!text) throw new Error('Empty Gemini response');
    const withPr = text.startsWith('PR｜') ? text : `PR｜${text}`;
    return clip(withPr, 105).replace(/楽天市場で詳細を見る↓.*$/s, '楽天市場で詳細を見る↓');
  } catch (err) {
    console.warn(`Gemini post generation failed: ${err.message}`);
    return fallbackPost(p);
  }
}

async function main() {
  const data = await readJson(PRODUCTS_PATH, null);
  if (!data?.products?.length) throw new Error('No products found in data/products.json');

  const state = await readJson(STATE_PATH, {postedItemCodes: [], posts: []});
  const date = todayJst();
  if (state.lastPostDate === date && process.env.FORCE_POST !== '1') {
    console.log(`Already posted on ${date}; skipping.`);
    return;
  }

  const product = chooseProduct(data.products, state);
  if (!product) throw new Error('No eligible product found');

  const copy = await aiPost(product);
  const text = `${copy}\n${product.affiliateUrl}`;
  console.log(`Posting item: ${product.itemCode}`);
  console.log(`Post copy preview:\n${copy}`);

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      authorization: oauthHeader('POST', API_URL),
      'content-type': 'application/json'
    },
    body: JSON.stringify({text})
  });
  const body = await res.text();
  let payload;
  try { payload = JSON.parse(body); } catch { payload = {raw: body}; }
  if (!res.ok) throw new Error(`X API ${res.status}: ${body.slice(0, 700)}`);

  const postId = payload?.data?.id || '';
  const postedItemCodes = [...(state.postedItemCodes || []), product.itemCode].slice(-60);
  const posts = [...(state.posts || []), {
    date,
    postId,
    itemCode: product.itemCode,
    category: product.category,
    title: product.shortTitle || product.itemName
  }].slice(-60);

  await fs.writeFile(STATE_PATH, JSON.stringify({lastPostDate: date, postedItemCodes, posts}, null, 2) + '\n');
  console.log(`X post created successfully: ${postId}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
