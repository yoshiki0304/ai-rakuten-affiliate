import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const required = ['RAKUTEN_APPLICATION_ID', 'RAKUTEN_ACCESS_KEY', 'RAKUTEN_AFFILIATE_ID'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required secret: ${key}`);
}

const SITE = 'https://yoshiki0304.github.io/ai-rakuten-affiliate';
const TARGET_PER_CATEGORY = 3;
const keywordGroups = [
  { category: '暮らし', keyword: '一人暮らし 便利グッズ' },
  { category: '暮らし', keyword: '新生活 便利グッズ' },
  { category: 'キッチン', keyword: 'キッチン 便利グッズ' },
  { category: 'キッチン', keyword: '調理 便利グッズ 一人暮らし' },
  { category: '収納', keyword: '収納 便利グッズ 一人暮らし' },
  { category: '収納', keyword: '省スペース 収納 便利グッズ' },
  { category: '掃除', keyword: '掃除 便利グッズ' },
  { category: '掃除', keyword: 'お風呂 掃除 便利グッズ' },
  { category: 'デスク', keyword: 'デスク 便利グッズ 在宅' },
  { category: 'デスク', keyword: '在宅ワーク デスク 周辺 便利' },
  { category: '防災', keyword: '防災グッズ 一人暮らし' },
  { category: '防災', keyword: '防災 セット 非常用' }
];
const categories = [...new Set(keywordGroups.map(x => x.category))];

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cmd = 'which google-chrome || which google-chrome-stable || which chromium || which chromium-browser';
  return execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' }).trim();
}

function scoreProduct(p) {
  const rating = Math.max(0, Math.min(5, Number(p.reviewAverage || 0)));
  const reviews = Math.log10(Number(p.reviewCount || 0) + 1);
  const rate = Math.min(20, Number(p.affiliateRate || 0));
  const point = Math.min(10, Number(p.pointRate || 0));
  const price = Number(p.itemPrice || 0);
  let pricePenalty = 0;
  if (price < 700) pricePenalty += 10;
  if (price > 30000) pricePenalty += 7;
  if (price > 60000) pricePenalty += 10;
  return rating * 21 + reviews * 17 + rate * 1.2 + point * 0.5 - pricePenalty;
}

function cleanTitle(name = '') {
  return String(name)
    .normalize('NFKC')
    .replace(/【[^】]*】|\[[^\]]*\]/g, ' ')
    .replace(/楽天(?:総合)?\s*\d+位|ランキング\s*\d+位|送料無料|ポイント\s*\d+倍|あす楽|クーポン(?:利用)?/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:mm|cm|m|ml|l|g|kg|枚|個|本|台|色|サイズ|セット|個入|枚入)\b/gi, ' ')
    .replace(/[!！?？★☆◆◇■□●○◎※]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function simpleTitle(name = '') {
  const cleaned = cleanTitle(name).replace(/^(?:PR\s*)+/i, '').trim();
  if (cleaned.length <= 42) return cleaned;
  return `${cleaned.slice(0, 41)}…`;
}

function similarityText(name = '') {
  return cleanTitle(name)
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?/g, '')
    .replace(/(?:一人暮らし|新生活|便利グッズ|おすすめ|人気|新居|引っ越し|引越し|ギフト|プレゼント)/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function bigrams(s) {
  const set = new Set();
  if (!s) return set;
  if (s.length < 2) {
    set.add(s);
    return set;
  }
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function titleSimilarity(a, b) {
  const aa = similarityText(a);
  const bb = similarityText(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  const short = aa.length <= bb.length ? aa : bb;
  const long = aa.length > bb.length ? aa : bb;
  if (short.length >= 10 && long.includes(short)) return short.length / long.length;
  const A = bigrams(aa);
  const B = bigrams(bb);
  let intersection = 0;
  for (const x of A) if (B.has(x)) intersection++;
  const union = A.size + B.size - intersection;
  return union ? intersection / union : 0;
}

function isTooSimilar(candidate, selected, threshold = 0.62) {
  return selected.some(p => titleSimilarity(candidate.itemName, p.itemName) >= threshold);
}

function fallbackSummary(p) {
  const rating = Number(p.reviewAverage || 0);
  const count = Number(p.reviewCount || 0);
  if (rating && count) {
    return `レビュー評価${rating.toFixed(1)}・${count.toLocaleString('ja-JP')}件の公開データを確認できる、${p.category}カテゴリの候補です。`;
  }
  return `楽天市場の商品情報をもとに選定した、${p.category}カテゴリの候補です。`;
}

async function collectProducts() {
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${SITE}/collector.html`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => typeof window.collectRakuten === 'function', { timeout: 30000 });

    const config = {
      applicationId: process.env.RAKUTEN_APPLICATION_ID,
      accessKey: process.env.RAKUTEN_ACCESS_KEY,
      affiliateId: process.env.RAKUTEN_AFFILIATE_ID,
      keywords: keywordGroups.map(x => x.keyword),
      hits: 30
    };

    return await page.evaluate(async cfg => window.collectRakuten(cfg), config);
  } finally {
    await browser.close();
  }
}

function selectProducts(raw) {
  const categoryByKeyword = new Map(keywordGroups.map(x => [x.keyword, x.category]));
  const exactSeen = new Set();
  const enriched = raw
    .filter(p => p && p.itemName && Number(p.itemPrice) > 0 && p.affiliateUrl && p.imageUrl && p.availability !== 0)
    .map(p => ({
      ...p,
      category: categoryByKeyword.get(p.keyword) || 'おすすめ',
      score: scoreProduct(p)
    }))
    .sort((a, b) => b.score - a.score)
    .filter(p => {
      const key = p.itemCode || `${p.shopCode}:${p.itemName}`;
      if (exactSeen.has(key)) return false;
      exactSeen.add(key);
      return true;
    });

  const selected = [];
  const shopTotals = new Map();

  for (const category of categories) {
    const candidates = enriched.filter(p => p.category === category);
    const picks = [];

    for (const p of candidates) {
      if (picks.length >= TARGET_PER_CATEGORY) break;
      if ((shopTotals.get(p.shopCode) || 0) >= 2) continue;
      if (picks.some(x => x.shopCode === p.shopCode)) continue;
      if (isTooSimilar(p, selected, 0.60) || isTooSimilar(p, picks, 0.60)) continue;
      picks.push(p);
      selected.push(p);
      shopTotals.set(p.shopCode, (shopTotals.get(p.shopCode) || 0) + 1);
    }

    if (picks.length < TARGET_PER_CATEGORY) {
      for (const p of candidates) {
        if (picks.length >= TARGET_PER_CATEGORY) break;
        if (selected.some(x => x.itemCode === p.itemCode)) continue;
        if (isTooSimilar(p, selected, 0.70)) continue;
        picks.push(p);
        selected.push(p);
        shopTotals.set(p.shopCode, (shopTotals.get(p.shopCode) || 0) + 1);
      }
    }
  }

  const globalOrder = [...selected].sort((a, b) => b.score - a.score);
  const globalRank = new Map(globalOrder.map((p, i) => [p.itemCode, i + 1]));
  const categoryCounters = new Map();

  return selected.map(p => {
    const rank = (categoryCounters.get(p.category) || 0) + 1;
    categoryCounters.set(p.category, rank);
    return { ...p, categoryRank: rank, globalRank: globalRank.get(p.itemCode) };
  });
}

async function addAiSummaries(products) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return products.map(p => ({ ...p, shortTitle: simpleTitle(p.itemName), aiSummary: fallbackSummary(p) }));

  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const compact = products.map(p => ({
    itemCode: p.itemCode,
    category: p.category,
    itemName: p.itemName.slice(0, 190),
    price: p.itemPrice,
    reviewAverage: p.reviewAverage,
    reviewCount: p.reviewCount,
    shopName: p.shopName
  }));

  const prompt = `あなたは日本のEC比較メディア編集者です。以下の商品データだけを根拠に、各商品についてJSONを作成してください。\n\n要件:\n- shortTitle: 商品名を28〜40文字程度に読みやすく短縮。元の商品名にない機能や効果を追加しない。\n- summary: 45〜75文字程度の選定メモ。商品名に明示された用途とレビュー評価・レビュー件数のみを根拠にする。\n- 実際に使用したような表現、効果の断定、最安・絶対・必ず・No.1などの未検証表現は禁止。\n- レビューが少ない場合は無理に評価を強調しない。\n- 出力はJSON配列のみ。各要素は {"itemCode":"...","shortTitle":"...","summary":"..."}。\n\n${JSON.stringify(compact)}`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
      })
    });
    if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '[]';
    const parsed = JSON.parse(text.replace(/^```json\s*|```$/g, '').trim());
    const map = new Map(parsed.map(x => [x.itemCode, x]));
    return products.map(p => ({
      ...p,
      shortTitle: map.get(p.itemCode)?.shortTitle || simpleTitle(p.itemName),
      aiSummary: map.get(p.itemCode)?.summary || fallbackSummary(p)
    }));
  } catch (err) {
    console.warn('Gemini generation failed; using fallback summaries:', err.message);
    return products.map(p => ({ ...p, shortTitle: simpleTitle(p.itemName), aiSummary: fallbackSummary(p) }));
  }
}

function esc(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function jpy(n) {
  return Number(n || 0).toLocaleString('ja-JP');
}

function dataBadge(p) {
  const rating = Number(p.reviewAverage || 0);
  const count = Number(p.reviewCount || 0);
  if (rating >= 4.6 && count >= 500) return '高評価・レビュー多数';
  if (count >= 2000) return 'レビュー多数';
  if (rating >= 4.6 && count >= 50) return '高評価';
  if (Number(p.itemPrice) <= 3000) return '3,000円以下';
  return '注目候補';
}

function renderCard(p) {
  const review = p.reviewAverage ? Number(p.reviewAverage).toFixed(2) : '—';
  const reviewCount = Number(p.reviewCount || 0);
  return `<article class="card">
    <a class="image" href="${esc(p.affiliateUrl)}" target="_blank" rel="nofollow sponsored noopener" aria-label="${esc(p.shortTitle)}を楽天市場で見る">
      <span class="rank-badge">${esc(p.category)} ${p.categoryRank}位</span>
      <img src="${esc(p.imageUrl)}" alt="${esc(p.shortTitle)}" loading="lazy">
    </a>
    <div class="card-body">
      <div class="card-flags"><span class="tag">${esc(p.category)}</span><span class="data-badge">${esc(dataBadge(p))}</span></div>
      <h3>${esc(p.shortTitle)}</h3>
      <p class="summary"><strong>AI選定メモ</strong>${esc(p.aiSummary)}</p>
      <div class="metrics"><div><span>評価</span><b>${esc(review)}</b></div><div><span>レビュー</span><b>${jpy(reviewCount)}件</b></div></div>
      <div class="shop">${esc(p.shopName)}</div>
      <div class="price">¥${jpy(p.itemPrice)}<span>価格・在庫等は楽天市場で最新情報をご確認ください</span></div>
      <a class="cta" href="${esc(p.affiliateUrl)}" target="_blank" rel="nofollow sponsored noopener">楽天市場で価格・詳細を見る</a>
    </div>
  </article>`;
}

function renderRankingCard(p) {
  const review = p.reviewAverage ? `★ ${Number(p.reviewAverage).toFixed(2)} / ${jpy(p.reviewCount)}件` : 'レビュー情報なし';
  return `<article class="ranking-card">
    <div class="ranking-number">${p.globalRank}</div>
    <a class="ranking-image" href="${esc(p.affiliateUrl)}" target="_blank" rel="nofollow sponsored noopener"><img src="${esc(p.imageUrl)}" alt="${esc(p.shortTitle)}"></a>
    <div class="ranking-body"><span class="tag">${esc(p.category)}</span><h3>${esc(p.shortTitle)}</h3><p>${esc(p.aiSummary)}</p><div class="ranking-meta">${esc(review)}</div><div class="ranking-price">¥${jpy(p.itemPrice)}</div><a class="cta secondary" href="${esc(p.affiliateUrl)}" target="_blank" rel="nofollow sponsored noopener">商品ページを見る</a></div>
  </article>`;
}

function renderHtml(products, updatedAt) {
  const sections = categories.map(category => {
    const rows = products.filter(p => p.category === category).sort((a, b) => a.categoryRank - b.categoryRank);
    if (!rows.length) return '';
    return `<section class="section" id="${encodeURIComponent(category)}"><div class="section-head"><div><span class="eyebrow">CATEGORY PICKS</span><h2>${esc(category)}のおすすめ</h2></div><p>類似商品を除外し、ショップの偏りを抑えながら公開データをもとに自動選定しています。</p></div><div class="grid">${rows.map(renderCard).join('')}</div></section>`;
  }).join('');

  const top3 = [...products].sort((a, b) => a.globalRank - b.globalRank).slice(0, 3);
  const nav = categories.map(c => `<a href="#${encodeURIComponent(c)}">${esc(c)}</a>`).join('');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>暮らしセレクト｜一人暮らしの便利グッズを自動比較</title>
<meta name="description" content="楽天市場の公開商品データをもとに、一人暮らしに役立つ便利グッズをレビュー評価・レビュー件数などから自動比較。AIが読みやすく整理して紹介します。">
<link rel="canonical" href="${SITE}/">
<meta property="og:title" content="暮らしセレクト｜一人暮らしの便利グッズを自動比較">
<meta property="og:description" content="楽天市場の公開データから、類似商品を除外して暮らしの便利グッズを自動選定。">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}/">
<style>
:root{--ink:#151515;--sub:#676767;--line:#e8e5df;--paper:#f7f5f1;--white:#fff;--accent:#b6251e;--accent2:#8f1712;--soft:#f1eee8;--max:1180px;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic",sans-serif;color:var(--ink);background:var(--paper)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper)}a{color:inherit}.wrap{max-width:var(--max);margin:auto;padding:0 24px}.top{background:#171717;color:#fff;font-size:12px;text-align:center;padding:9px 16px}.nav{height:72px;border-bottom:1px solid var(--line);background:rgba(247,245,241,.94);position:sticky;top:0;z-index:20;backdrop-filter:blur(12px)}.nav-inner{height:100%;display:flex;align-items:center;justify-content:space-between}.brand{font-weight:900;font-size:22px;letter-spacing:.04em;text-decoration:none}.navlinks{display:flex;gap:17px;font-size:13px;color:#555}.navlinks a{text-decoration:none}.hero{padding:74px 0 62px;border-bottom:1px solid var(--line)}.hero-inner{display:grid;grid-template-columns:1.25fr .75fr;gap:64px;align-items:end}.kicker,.eyebrow{font-size:11px;font-weight:900;letter-spacing:.17em;color:var(--accent)}h1{font-size:clamp(39px,6vw,74px);line-height:1.03;letter-spacing:-.045em;margin:15px 0 20px}.hero p{font-size:16px;line-height:1.9;color:#555;max-width:680px}.hero-note{border-left:1px solid #bbb;padding-left:24px;font-size:13px;line-height:1.85;color:#666}.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:24px}.chips a{text-decoration:none;background:#fff;border:1px solid var(--line);border-radius:999px;padding:9px 13px;font-size:12px;font-weight:700}.ranking{padding:66px 0;border-bottom:1px solid var(--line)}.ranking-head{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:25px}.ranking-head h2{font-size:36px;letter-spacing:-.03em;margin:7px 0 0}.ranking-head p{max-width:420px;color:var(--sub);font-size:13px;line-height:1.7}.ranking-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.ranking-card{position:relative;background:#1a1a1a;color:#fff;border-radius:20px;overflow:hidden}.ranking-number{position:absolute;z-index:2;top:14px;left:14px;background:#fff;color:#111;width:42px;height:42px;border-radius:50%;display:grid;place-items:center;font-size:19px;font-weight:900;box-shadow:0 6px 20px rgba(0,0,0,.18)}.ranking-image{display:block;aspect-ratio:1.24/1;background:#fff}.ranking-image img{width:100%;height:100%;object-fit:contain}.ranking-body{padding:18px}.ranking-body .tag{color:#ff8c84}.ranking-body h3{font-size:17px;line-height:1.5;margin:8px 0}.ranking-body p{font-size:12px;line-height:1.65;color:#ccc;min-height:40px}.ranking-meta{font-size:12px;color:#bbb}.ranking-price{font-size:25px;font-weight:900;margin:8px 0 13px}.section{padding:68px 0;border-bottom:1px solid var(--line)}.section-head{display:flex;justify-content:space-between;gap:28px;align-items:end;margin-bottom:26px}.section-head h2{font-size:34px;margin:7px 0 0;letter-spacing:-.02em}.section-head p{font-size:13px;color:var(--sub);max-width:420px;line-height:1.7}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.card{background:var(--white);border:1px solid var(--line);border-radius:18px;overflow:hidden;display:flex;flex-direction:column;min-width:0;box-shadow:0 3px 16px rgba(20,20,20,.035)}.image{display:block;position:relative;aspect-ratio:1.12/1;background:#fff;overflow:hidden}.image img{width:100%;height:100%;object-fit:contain;transition:transform .25s ease}.image:hover img{transform:scale(1.025)}.rank-badge{position:absolute;z-index:2;top:12px;left:12px;background:#171717;color:#fff;padding:7px 10px;border-radius:999px;font-size:11px;font-weight:800}.card-body{padding:17px;display:flex;flex-direction:column;flex:1}.card-flags{display:flex;align-items:center;justify-content:space-between;gap:8px}.tag{font-size:11px;font-weight:900;color:var(--accent);letter-spacing:.07em}.data-badge{font-size:10px;font-weight:800;background:#f3ece9;color:#7b2823;padding:5px 7px;border-radius:999px}.card h3{font-size:17px;line-height:1.52;margin:10px 0}.summary{font-size:12.5px;line-height:1.7;color:#555;margin:0 0 14px}.summary strong{display:block;color:#222;font-size:10px;letter-spacing:.08em;margin-bottom:4px}.metrics{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:auto}.metrics div{padding:9px 10px}.metrics div+div{border-left:1px solid var(--line)}.metrics span{display:block;font-size:9px;color:#888}.metrics b{font-size:13px}.shop{font-size:10px;color:#888;margin-top:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.price{font-size:23px;font-weight:900;margin:7px 0 12px}.price span{display:block;font-size:9px;font-weight:400;color:#888;margin-top:3px}.cta{display:flex;align-items:center;justify-content:center;min-height:47px;text-align:center;text-decoration:none;background:var(--accent);color:#fff;padding:12px 10px;border-radius:10px;font-size:13px;font-weight:900;transition:background .2s ease}.cta:hover{background:var(--accent2)}.cta.secondary{background:#fff;color:#171717}.cta.secondary:hover{background:#eee}.about{padding:56px 0}.about-box{background:#1c1c1c;color:#fff;border-radius:20px;padding:32px}.about-box h2{margin-top:0}.about-box p{color:#ccc;line-height:1.85;font-size:13px}.footer{border-top:1px solid var(--line);padding:30px 0 48px;font-size:11px;color:#777;line-height:1.85}.footer a{color:#555}@media(max-width:900px){.hero-inner{grid-template-columns:1fr}.hero-note{display:none}.ranking-grid,.grid{grid-template-columns:repeat(2,1fr)}.ranking-card:first-child{grid-column:1/-1}.ranking-card:first-child{display:grid;grid-template-columns:.9fr 1.1fr}.ranking-card:first-child .ranking-image{aspect-ratio:auto}.section-head,.ranking-head{display:block}.section-head p,.ranking-head p{margin-top:10px}.navlinks{display:none}}@media(max-width:600px){.wrap{padding:0 15px}.top{font-size:10px}.nav{height:62px}.brand{font-size:19px}.hero{padding:46px 0}.hero p{font-size:14px}.chips{gap:6px}.chips a{padding:8px 10px}.ranking{padding:48px 0}.ranking-head h2,.section-head h2{font-size:28px}.ranking-grid,.grid{grid-template-columns:1fr}.ranking-card:first-child{display:block}.ranking-card:first-child .ranking-image{aspect-ratio:1.24/1}.section{padding:48px 0}.card{border-radius:16px}.image{aspect-ratio:1.3/1}.card h3{font-size:16px}.summary{font-size:12px}.metrics b{font-size:12px}.price{font-size:22px}.cta{font-size:14px;min-height:50px}.about-box{padding:24px}}
</style>
</head>
<body>
<div class="top">PR｜当サイトは楽天アフィリエイトプログラムを利用しています</div>
<header class="nav"><div class="wrap nav-inner"><a class="brand" href="#">暮らしセレクト</a><nav class="navlinks">${nav}</nav></div></header>
<main>
<section class="hero"><div class="wrap hero-inner"><div><span class="kicker">SMART LIVING PICKS</span><h1>買う前に、<br>候補を絞る。</h1><p>楽天市場の公開商品データから、評価・レビュー件数などをスコア化。類似商品や同一ショップへの偏りを抑え、AIが商品名と公開データを読みやすく整理します。</p><div class="chips">${nav}</div></div><div class="hero-note">最終更新：${esc(updatedAt)}<br>商品価格・在庫・ポイント等は変動します。購入前に楽天市場の商品ページで最新情報をご確認ください。</div></div></section>
<section class="ranking"><div class="wrap"><div class="ranking-head"><div><span class="eyebrow">OVERALL TOP 3</span><h2>今日の総合ランキング</h2></div><p>掲載候補の中から、レビュー評価・レビュー件数などの公開データをもとにスコア順で表示しています。</p></div><div class="ranking-grid">${top3.map(renderRankingCard).join('')}</div></div></section>
<div class="wrap">${sections}<section class="about"><div class="about-box"><h2>選定ロジックについて</h2><p>楽天市場APIから取得した商品情報をもとに、レビュー評価・レビュー件数などをスコアリングします。その後、同一商品コードの重複に加えて商品名の類似度も判定し、近いバリエーションの連続掲載を抑制。同一ショップの掲載数にも上限を設けています。AIは商品名と公開レビュー指標を読みやすく整理する目的で使用しており、商品の使用感を実体験したものではありません。</p></div></section></div>
</main>
<footer class="footer"><div class="wrap">当サイトは楽天アフィリエイトプログラムを利用しており、リンク経由の購入により報酬を受け取る場合があります。価格・在庫・送料・ポイント等は変更される場合があります。<br>Supported by <a href="https://webservice.rakuten.co.jp/" target="_blank" rel="noopener">Rakuten Web Service</a></div></footer>
</body></html>`;
}

async function main() {
  console.log('Collecting Rakuten products from allowed web origin...');
  const raw = await collectProducts();
  console.log(`Collected ${raw.length} rows.`);
  const selected = selectProducts(raw);
  if (selected.length < 10) throw new Error(`Too few products selected after diversity filtering: ${selected.length}`);
  console.log(`Selected ${selected.length} diversified products.`);
  const products = await addAiSummaries(selected);
  const updatedAt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date());
  await fs.mkdir(path.join(process.cwd(), 'data'), { recursive: true });
  await fs.writeFile(path.join(process.cwd(), 'data', 'products.json'), JSON.stringify({ updatedAt, selection: { targetPerCategory: TARGET_PER_CATEGORY, categories }, products }, null, 2) + '\n');
  await fs.writeFile(path.join(process.cwd(), 'index.html'), renderHtml(products, updatedAt));
  console.log('Site generated successfully.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});