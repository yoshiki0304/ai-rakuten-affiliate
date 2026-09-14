import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const required = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required secret: ${key}`);
}

const PRODUCTS_PATH = new URL('../data/products.json', import.meta.url);
const STATE_PATH = new URL('../data/x-state.json', import.meta.url);
const ANALYTICS_PATH = new URL('../data/x-analytics.json', import.meta.url);
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
    .map(([k, v]) => `${enc(k)}=\"${enc(v)}\"`)
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

function n(value) {
  const x = Number(value || 0);
  return Number.isFinite(x) ? x : 0;
}

function clean(s = '') {
  return String(s).replace(/\s+/g, ' ').trim();
}

function clip(s, max) {
  const chars = Array.from(clean(s));
  return chars.length <= max ? chars.join('') : chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

function performanceScore(entry) {
  const m = entry?.metrics || {};
  const r = entry?.rates || {};
  const impressions = n(m.impressions);
  const clicks = n(m.urlClicks);
  const engagements = n(m.engagements);
  const ctrAdjusted = ((clicks + 1) / (impressions + 50)) * 100;
  const engagementAdjusted = ((engagements + 1) / (impressions + 50)) * 100;

  return (
    Math.log1p(impressions) * 1.2 +
    Math.log1p(clicks) * 4.0 +
    ctrAdjusted * 1.5 +
    Math.log1p(engagements) * 1.0 +
    engagementAdjusted * 0.4 +
    Math.log1p(n(m.bookmarks)) * 2.0 +
    Math.log1p(n(m.profileClicks)) * 1.5 +
    Math.log1p(n(m.reposts)) * 1.0 +
    Math.log1p(n(m.likes)) * 0.5 +
    Math.sqrt(Math.max(0, n(r.ctr))) * 0.4
  );
}

function buildLearningContext(analytics) {
  const recent = (analytics?.entries || [])
    .filter(x => x?.postId && x?.text)
    .slice(-30)
    .map(x => ({...x, score: Number(performanceScore(x).toFixed(3))}));

  if (!recent.length) {
    return {
      count: 0,
      strength: 'none',
      explore: true,
      breakoutExample: null,
      topExamples: [],
      preferredCategories: []
    };
  }

  const ranked = [...recent].sort((a, b) => b.score - a.score);
  const breakoutExample = ranked[0];
  const topExamples = ranked.slice(0, recent.length >= 7 ? 5 : Math.min(2, recent.length));

  const categoryMap = new Map();
  for (const entry of recent) {
    const category = entry.category || '';
    if (!category) continue;
    const cur = categoryMap.get(category) || {count: 0, total: 0};
    cur.count += 1;
    cur.total += entry.score;
    categoryMap.set(category, cur);
  }

  const preferredCategories = [...categoryMap.entries()]
    .filter(([, v]) => recent.length < 10 ? v.count >= 1 : v.count >= 2)
    .map(([category, v]) => ({category, count: v.count, averageScore: v.total / v.count}))
    .sort((a, b) => b.averageScore - a.averageScore)
    .slice(0, 2)
    .map(x => x.category);

  const strength = recent.length >= 7 ? 'strong' : recent.length >= 3 ? 'light' : 'collecting';
  const exploreRate = strength === 'strong' ? 0.30 : strength === 'light' ? 0.50 : 1.00;

  return {
    count: recent.length,
    strength,
    explore: Math.random() < exploreRate,
    breakoutExample,
    topExamples,
    preferredCategories
  };
}

function chooseProduct(products, state, learning) {
  const recentItems = new Set((state.postedItemCodes || []).slice(-24));
  const sorted = [...products]
    .filter(p => p.itemCode && p.affiliateUrl && !recentItems.has(p.itemCode))
    .sort((a, b) => Number(a.globalRank || 999) - Number(b.globalRank || 999));

  const fallback = sorted.length
    ? sorted
    : [...products]
      .filter(p => p.itemCode && p.affiliateUrl)
      .sort((a, b) => Number(a.globalRank || 999) - Number(b.globalRank || 999));

  if (!fallback.length) return null;

  if (learning.strength === 'strong' && !learning.explore && learning.preferredCategories.length) {
    const preferred = fallback.find(p => learning.preferredCategories.includes(p.category));
    if (preferred) return preferred;
  }

  return fallback[0];
}

function fallbackPost(p) {
  const rating = Number(p.reviewAverage || 0);
  const reviews = Number(p.reviewCount || 0);
  const title = clip(p.shortTitle || p.itemName, 34);
  const detail = rating && reviews
    ? `レビュー${reviews.toLocaleString('ja-JP')}件、★${rating.toFixed(1)}。`
    : '';
  return `PR｜こういうの、必要になる前に見つけておきたい。\n${title}\n${detail}楽天市場で詳細を見る↓`;
}

function summarizeExample(x, rank = null) {
  if (!x) return null;
  return {
    rank,
    category: x.category,
    price: x.price,
    impressions: x.metrics?.impressions,
    urlClicks: x.metrics?.urlClicks,
    ctr: x.rates?.ctr,
    engagementRate: x.rates?.engagementRate,
    likes: x.metrics?.likes,
    reposts: x.metrics?.reposts,
    bookmarks: x.metrics?.bookmarks,
    profileClicks: x.metrics?.profileClicks,
    score: x.score,
    text: String(x.text || '').replace(/https?:\/\/\S+/g, '').trim()
  };
}

function learningExamplesForPrompt(learning) {
  if (!learning.topExamples.length) return 'まだ十分な過去データがありません。今回は自然な新パターンを作ってください。';

  return learning.topExamples
    .map((x, i) => JSON.stringify(summarizeExample(x, i + 1)))
    .join('\n');
}

function breakoutForPrompt(learning) {
  if (!learning.breakoutExample) return 'なし';
  return JSON.stringify(summarizeExample(learning.breakoutExample, 1));
}

async function aiPost(p, learning) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return fallbackPost(p);
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const mode = learning.explore ? '探索' : '勝ちパターン活用';

  const prompt = `楽天アフィリエイト用のX投稿文を1本だけ作成してください。\n\n目的:\n- 広告文・AI文に見える定型感を減らし、自然に商品を見つけて紹介しているような会話調にする。\n- ただし、本人が実際に買った・使った・愛用している等の体験は絶対に捏造しない。\n- 過去の実績がある場合は、文章をコピーせず「冒頭の入り方・情報量・テンポ・数字の使い方」だけを学ぶ。\n- たまたま1投稿だけ大きく伸びた場合でも、その投稿は必ず学習対象から外さない。単発のヒットからも、冒頭・話題・情報量・テンポなど再利用可能な要素を抽出する。\n- ただし単発ヒット1件だけを理由に、全投稿を同じカテゴリ・同じ言い回しへ固定しない。再現性が確認できるまでは「有力な仮説」として扱う。\n\n今回の運用モード: ${mode}\n学習データ件数: ${learning.count}\n学習強度: ${learning.strength}\n\n厳守事項:\n- 日本語。URLを除いて、おおむね80〜135文字。\n- 1行目は必ず「PR｜」から開始。\n- 2〜4行程度。毎回同じ構成にしない。\n- 商品名を長々とそのまま書かない。\n- 商品データから1〜2個だけ、価格・レビュー数・評価・用途など具体情報を使う。全部詰め込まない。\n- 「高評価です」「注目アイテム」「おすすめです」「楽天市場の公開商品データから選定」など広告・AIっぽい定型句は避ける。\n- 「買ってみた」「使ってみた」「愛用中」「我が家では」「実際に届いた」など未確認の体験表現は禁止。\n- 最安、絶対、必ず、No.1、神コスパ等の未検証の断定は禁止。\n- ハッシュタグ不要。絵文字は原則不要。\n- 口語的でも、煽りすぎない。\n- URLは出力しない。最後は自然に「楽天市場で詳細を見る↓」で終える。\n- 文章だけ返す。\n\n単発でも必ず参考にする歴代トップ投稿:\n${breakoutForPrompt(learning)}\n\n過去の反応が良かった投稿データ（上ほど総合評価が高い）:\n${learningExamplesForPrompt(learning)}\n\n商品データ:\n${JSON.stringify({category:p.category, title:p.shortTitle||p.itemName, price:p.itemPrice, reviewAverage:p.reviewAverage, reviewCount:p.reviewCount, summary:p.aiSummary})}`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.72}})
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const json = await res.json();
    const text = clean(json?.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '');
    if (!text) throw new Error('Empty Gemini response');
    const withPr = text.startsWith('PR｜') ? text : `PR｜${text}`;
    return clip(withPr, 145).replace(/楽天市場で詳細を見る↓.*$/s, '楽天市場で詳細を見る↓');
  } catch (err) {
    console.warn(`Gemini post generation failed: ${err.message}`);
    return fallbackPost(p);
  }
}

async function main() {
  const data = await readJson(PRODUCTS_PATH, null);
  if (!data?.products?.length) throw new Error('No products found in data/products.json');

  const state = await readJson(STATE_PATH, {postedItemCodes: [], posts: []});
  const analytics = await readJson(ANALYTICS_PATH, {entries: []});
  const learning = buildLearningContext(analytics);
  const date = todayJst();

  if (state.lastPostDate === date && process.env.FORCE_POST !== '1') {
    console.log(`Already posted on ${date}; skipping.`);
    return;
  }

  const product = chooseProduct(data.products, state, learning);
  if (!product) throw new Error('No eligible product found');

  const copy = await aiPost(product, learning);
  const text = `${copy}\n${product.affiliateUrl}`;
  console.log(`Posting item: ${product.itemCode}`);
  console.log(`Learning mode: ${learning.strength} / ${learning.explore ? 'explore' : 'exploit'} / ${learning.count} analyzed posts`);
  if (learning.breakoutExample) console.log(`Breakout reference post: ${learning.breakoutExample.postId}`);
  if (learning.preferredCategories.length) console.log(`Preferred categories: ${learning.preferredCategories.join(', ')}`);
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
    title: product.shortTitle || product.itemName,
    learningMode: learning.explore ? 'explore' : 'exploit',
    learningCount: learning.count,
    breakoutReferencePostId: learning.breakoutExample?.postId || null
  }].slice(-60);

  await fs.writeFile(STATE_PATH, JSON.stringify({lastPostDate: date, postedItemCodes, posts}, null, 2) + '\n');
  console.log(`X post created successfully: ${postId}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
