import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const required = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required secret: ${key}`);
}

const STATE_PATH = new URL('../data/x-state.json', import.meta.url);
const ANALYTICS_PATH = new URL('../data/x-analytics.json', import.meta.url);
const PRODUCTS_PATH = new URL('../data/products.json', import.meta.url);
const REPORT_DIR = new URL('../reports/x-daily/', import.meta.url);

const enc = value => encodeURIComponent(String(value))
  .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function oauthHeader(method, baseUrl, query = {}) {
  const oauth = {
    oauth_consumer_key: process.env.X_API_KEY,
    oauth_nonce: crypto.randomBytes(18).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: process.env.X_ACCESS_TOKEN,
    oauth_version: '1.0'
  };

  const signatureParams = [...Object.entries(oauth), ...Object.entries(query)]
    .sort(([a, av], [b, bv]) => a === b ? String(av).localeCompare(String(bv)) : a.localeCompare(b));

  const normalized = signatureParams
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join('&');

  const base = [method.toUpperCase(), enc(baseUrl), enc(normalized)].join('&');
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

function nowJst() {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(new Date());
}

function n(value) {
  const x = Number(value || 0);
  return Number.isFinite(x) ? x : 0;
}

function pct(num, den) {
  return den > 0 ? Number(((num / den) * 100).toFixed(2)) : 0;
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + n(b), 0) / values.length;
}

function fmt(value, digits = 0) {
  return Number(value || 0).toLocaleString('ja-JP', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function deltaText(current, baseline, suffix = '') {
  if (!baseline) return '比較データなし';
  const diff = ((current - baseline) / baseline) * 100;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff.toFixed(1)}%${suffix}`;
}

async function fetchPost(postId) {
  const baseUrl = `https://api.x.com/2/tweets/${encodeURIComponent(postId)}`;
  const query = {
    'tweet.fields': 'created_at,public_metrics,non_public_metrics,organic_metrics'
  };
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${baseUrl}?${qs}`, {
    headers: {
      authorization: oauthHeader('GET', baseUrl, query)
    }
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`X API ${res.status}: ${body.slice(0, 700)}`);
  return JSON.parse(body)?.data;
}

function fallbackAnalysis(entry, baseline) {
  const notes = [];
  if (!baseline.count) {
    notes.push('まだ比較母数が少ないため、まず7件程度のデータを蓄積します。');
  } else {
    if (entry.rates.ctr > baseline.ctr) notes.push('URLクリック率は直近平均を上回っています。商品テーマと訴求の組み合わせは継続候補です。');
    else notes.push('URLクリック率は直近平均を下回っています。冒頭の訴求、価格帯、商品カテゴリを見直す余地があります。');

    if (entry.metrics.impressions < baseline.impressions) notes.push('表示回数が直近平均を下回っているため、投稿テーマとアカウント認知の改善が優先です。');
    if (entry.rates.engagementRate > baseline.engagementRate) notes.push('エンゲージメント率は直近平均より良好です。');
  }

  return `### AI所見\n${notes.map(x => `- ${x}`).join('\n')}\n\n### 次回方針\n- 1日1投稿を維持し、データを蓄積する\n- CTRと表示回数を最優先KPIとして比較する\n- 7件以上たまったらカテゴリ別・価格帯別の傾向を強く反映する`;
}

async function aiAnalysis(entry, baseline, recent) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.warn('[Gemini] 代替処理発動: API key is not configured.');
    return fallbackAnalysis(entry, baseline);
  }
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const prompt = `Xで運用している楽天アフィリエイト投稿の日次分析をしてください。\n数字にない事実は作らず、因果関係は断定せず仮説として書いてください。\n売上・購入数はデータがないので推測しないでください。\n日本語で、以下の4見出しだけを使って簡潔に出力してください。\n\n### 総合評価\nA〜Dの1段階評価と理由を2文以内。\n### 良かった点\n箇条書き最大3つ。\n### 改善点\n箇条書き最大3つ。\n### 次回方針\n明日以降の商品選定・文章改善を具体的に最大4つ。\n\n今回のデータ:\n${JSON.stringify(entry)}\n\n直近比較平均:\n${JSON.stringify(baseline)}\n\n直近履歴:\n${JSON.stringify(recent)}`;

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let retryable = true;
    // Keep diagnostics free of request URLs, credentials, and response bodies.
    let reason = 'network, timeout, or invalid response';
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          contents: [{parts: [{text: prompt}]}],
          generationConfig: {temperature: 0.25}
        })
      });
      if (!res.ok) {
        reason = `HTTP ${res.status}`;
        retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
        throw new Error('Gemini HTTP error');
      }
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('').trim();
      if (!text) {
        reason = 'empty response';
        throw new Error('Empty Gemini response');
      }
      console.log(`[Gemini] Gemini成功: attempt ${attempt}/${maxAttempts}`);
      return text;
    } catch {
      console.warn(`[Gemini] Attempt ${attempt}/${maxAttempts} failed: ${reason}`);
      if (!retryable || attempt === maxAttempts) {
        console.warn(`[Gemini] 代替処理発動: ${reason}; continuing report generation.`);
        return fallbackAnalysis(entry, baseline);
      }
      const delayMs = attempt * 3000;
      console.log(`[Gemini] Retrying in ${delayMs / 1000}s.`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

async function writeNoTargetReport(reportDate) {
  await fs.mkdir(REPORT_DIR, {recursive: true});
  const report = `# X集計｜${reportDate}\n\n集計対象のX投稿がまだありません。\n`;
  await fs.writeFile(new URL(`${reportDate}.md`, REPORT_DIR), report);
  await fs.writeFile(new URL('latest.md', REPORT_DIR), report);
  console.log('No X post found. Status report written.');
}

async function main() {
  const state = await readJson(STATE_PATH, {posts: []});
  const analytics = await readJson(ANALYTICS_PATH, {entries: []});
  const products = await readJson(PRODUCTS_PATH, {products: []});
  const reportDate = todayJst();
  const collectedAt = nowJst();

  const target = [...(state.posts || [])].reverse().find(p => p.postId);

  if (!target) {
    await writeNoTargetReport(reportDate);
    return;
  }

  const post = await fetchPost(target.postId);
  if (!post) throw new Error('X API returned no post data');

  const pub = post.public_metrics || {};
  const priv = post.non_public_metrics || {};
  const org = post.organic_metrics || {};
  const impressions = n(pub.impression_count || priv.impression_count || org.impression_count);
  const engagements = n(priv.engagements);
  const urlClicks = n(priv.url_link_clicks || org.url_link_clicks);
  const profileClicks = n(priv.user_profile_clicks || org.user_profile_clicks);

  const product = (products.products || []).find(p => p.itemCode === target.itemCode) || {};
  const previous = (analytics.entries || [])
    .filter(x => String(x.postId || '') !== String(target.postId))
    .slice(-7);
  const baseline = {
    count: previous.length,
    impressions: avg(previous.map(x => x.metrics?.impressions)),
    urlClicks: avg(previous.map(x => x.metrics?.urlClicks)),
    ctr: avg(previous.map(x => x.rates?.ctr)),
    engagementRate: avg(previous.map(x => x.rates?.engagementRate))
  };

  const entry = {
    reportDate,
    collectedAt,
    postDate: target.date || null,
    postId: String(target.postId),
    itemCode: target.itemCode || null,
    category: target.category || product.category || null,
    title: target.title || product.shortTitle || product.itemName || null,
    price: n(product.itemPrice),
    text: post.text || '',
    createdAt: post.created_at || null,
    metrics: {
      impressions,
      likes: n(pub.like_count),
      reposts: n(pub.retweet_count),
      replies: n(pub.reply_count),
      quotes: n(pub.quote_count),
      bookmarks: n(pub.bookmark_count),
      urlClicks,
      profileClicks,
      engagements
    },
    rates: {
      ctr: pct(urlClicks, impressions),
      engagementRate: pct(engagements, impressions)
    }
  };

  const recentForAi = previous.map(x => ({
    reportDate: x.reportDate,
    category: x.category,
    price: x.price,
    impressions: x.metrics?.impressions,
    urlClicks: x.metrics?.urlClicks,
    ctr: x.rates?.ctr,
    engagementRate: x.rates?.engagementRate
  }));

  const analysisText = await aiAnalysis(entry, baseline, recentForAi);
  const allEntries = [
    ...(analytics.entries || []).filter(x => String(x.postId || '') !== String(entry.postId)),
    entry
  ].slice(-90);
  await fs.writeFile(ANALYTICS_PATH, JSON.stringify({entries: allEntries}, null, 2) + '\n');

  await fs.mkdir(REPORT_DIR, {recursive: true});
  const report = `# X集計｜${reportDate}\n\n- 集計時刻: ${entry.collectedAt}\n\n## 対象投稿\n- 投稿日: ${entry.postDate || '-'}\n- カテゴリ: ${entry.category || '-'}\n- 商品: ${entry.title || '-'}\n- 価格: ${entry.price ? `${fmt(entry.price)}円` : '-'}\n- Post ID: ${entry.postId}\n\n## KPI\n| 指標 | 今回 | 直近平均との比較 |\n|---|---:|---:|\n| 閲覧回数（インプレッション） | ${fmt(entry.metrics.impressions)} | ${deltaText(entry.metrics.impressions, baseline.impressions)} |\n| 反応回数（エンゲージメント） | ${fmt(entry.metrics.engagements)} | - |\n| いいね | ${fmt(entry.metrics.likes)} | - |\n| URLクリック | ${fmt(entry.metrics.urlClicks)} | ${deltaText(entry.metrics.urlClicks, baseline.urlClicks)} |\n| CTR | ${fmt(entry.rates.ctr, 2)}% | ${baseline.count ? `${deltaText(entry.rates.ctr, baseline.ctr)}` : '比較データなし'} |\n| エンゲージメント率 | ${fmt(entry.rates.engagementRate, 2)}% | ${baseline.count ? `${deltaText(entry.rates.engagementRate, baseline.engagementRate)}` : '比較データなし'} |\n| リポスト | ${fmt(entry.metrics.reposts)} | - |\n| 返信 | ${fmt(entry.metrics.replies)} | - |\n| ブックマーク | ${fmt(entry.metrics.bookmarks)} | - |\n| プロフィールクリック | ${fmt(entry.metrics.profileClicks)} | - |\n\n## 7投稿基準\n- 比較件数: ${baseline.count}件\n- 平均インプレッション: ${fmt(baseline.impressions)}\n- 平均URLクリック: ${fmt(baseline.urlClicks, 1)}\n- 平均CTR: ${fmt(baseline.ctr, 2)}%\n- 平均エンゲージメント率: ${fmt(baseline.engagementRate, 2)}%\n\n${analysisText}\n\n## 運用メモ\n- 同じ投稿を1日複数回再集計し、最新値に更新します。\n- 売上や成果報酬は楽天側の実績データを連携するまで、このレポートでは評価しません。\n`;

  await fs.writeFile(new URL(`${reportDate}.md`, REPORT_DIR), report);
  await fs.writeFile(new URL('latest.md', REPORT_DIR), report);
  console.log(`X analytics refreshed for post ${entry.postId} at ${entry.collectedAt}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
