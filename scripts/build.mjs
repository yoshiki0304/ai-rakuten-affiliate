import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const required = ['RAKUTEN_APPLICATION_ID', 'RAKUTEN_ACCESS_KEY', 'RAKUTEN_AFFILIATE_ID'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required secret: ${key}`);
}

const SITE = 'https://yoshiki0304.github.io/ai-rakuten-affiliate';
const keywordGroups = [
  { category: '暮らし', keyword: '一人暮らし 便利グッズ' },
  { category: 'キッチン', keyword: 'キッチン 便利グッズ 一人暮らし' },
  { category: '収納', keyword: '収納 便利グッズ 一人暮らし' },
  { category: '掃除', keyword: '掃除 便利グッズ 一人暮らし' },
  { category: 'デスク', keyword: 'デスク 便利グッズ 在宅' },
  { category: '防災', keyword: '防災グッズ 一人暮らし' }
];

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cmd = 'which google-chrome || which google-chrome-stable || which chromium || which chromium-browser';
  return execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' }).trim();
}

function scoreProduct(p) {
  const rating = Math.max(0, Math.min(5, Number(p.reviewAverage || 0)));
  const reviews = Math.log10(Number(p.reviewCount || 0) + 1);
  const rate = Math.min(30, Number(p.affiliateRate || 0));
  const point = Math.min(20, Number(p.pointRate || 0));
  const price = Number(p.itemPrice || 0);
  const pricePenalty = price < 500 || price > 50000 ? 12 : 0;
  return rating * 20 + reviews * 18 + rate * 2 + point * 0.5 - pricePenalty;
}

function fallbackSummary(p) {
  const rating = p.reviewAverage ? `レビュー評価${Number(p.reviewAverage).toFixed(1)}` : '楽天市場で取り扱い中';
  const count = p.reviewCount ? `、${Number(p.reviewCount).toLocaleString('ja-JP')}件のレビュー` : '';
  return `${rating}${count}を参考に選んだ、${p.category}向けの注目アイテムです。`;
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
  const seen = new Set();
  const enriched = raw
    .filter(p => p && p.itemName && p.itemPrice > 0 && p.affiliateUrl && p.availability !== 0)
    .map(p => ({ ...p, category: categoryByKeyword.get(p.keyword) || 'おすすめ', score: scoreProduct(p) }))
    .sort((a, b) => b.score - a.score)
    .filter(p => {
      const key = p.itemCode || `${p.shopCode}:${p.itemName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const selected = [];
  for (const group of keywordGroups) {
    selected.push(...enriched.filter(p => p.category === group.category).slice(0, 4));
  }
  return selected.slice(0, 24);
}

async function addAiSummaries(products) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return products.map(p => ({ ...p, aiSummary: fallbackSummary(p) }));

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const compact = products.map(p => ({
    itemCode: p.itemCode,
    category: p.category,
    itemName: p.itemName.slice(0, 160),
    price: p.itemPrice,
    reviewAverage: p.reviewAverage,
    reviewCount: p.reviewCount
  }));

  const prompt = `あなたは日本のEC比較メディア編集者です。以下の商品ごとに、商品データだけを根拠として45〜75文字程度の日本語の「選定理由」を1文で作ってください。誇張、断定、未確認の性能、最安・絶対・必ず等の表現は禁止です。価格は本文に入れなくて構いません。JSON配列のみを返し、各要素は {"itemCode":"...","summary":"..."} としてください。\n\n${JSON.stringify(compact)}`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.35, responseMimeType: 'application/json' }
      })
    });
    if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '[]';
    const parsed = JSON.parse(text.replace(/^```json\s*|```$/g, '').trim());
    const map = new Map(parsed.map(x => [x.itemCode, x.summary]));
    return products.map(p => ({ ...p, aiSummary: map.get(p.itemCode) || fallbackSummary(p) }));
  } catch (err) {
    console.warn('Gemini generation failed; using fallback summaries:', err.message);
    return products.map(p => ({ ...p, aiSummary: fallbackSummary(p) }));
  }
}

function esc(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function jpy(n) {
  return Number(n || 0).toLocaleString('ja-JP');
}

function renderCard(p) {
  const review = p.reviewAverage ? `★ ${Number(p.reviewAverage).toFixed(2)} / ${jpy(p.reviewCount)}件` : 'レビュー情報なし';
  return `<article class="card">
    <a class="image" href="${esc(p.affiliateUrl)}" target="_blank" rel="nofollow sponsored noopener"><img src="${esc(p.imageUrl)}" alt="${esc(p.itemName)}" loading="lazy"></a>
    <div class="card-body">
      <span class="tag">${esc(p.category)}</span>
      <h3>${esc(p.itemName)}</h3>
      <p class="summary">${esc(p.aiSummary)}</p>
      <div class="rating">${esc(review)}</div>
      <div class="price">¥${jpy(p.itemPrice)}<span>（税込表示は楽天市場側をご確認ください）</span></div>
      <a class="cta" href="${esc(p.affiliateUrl)}" target="_blank" rel="nofollow sponsored noopener">楽天市場で詳細を見る</a>
    </div>
  </article>`;
}

function renderHtml(products, updatedAt) {
  const categories = keywordGroups.map(x => x.category);
  const sections = categories.map(category => {
    const rows = products.filter(p => p.category === category);
    if (!rows.length) return '';
    return `<section class="section" id="${encodeURIComponent(category)}"><div class="section-head"><div><span class="eyebrow">CURATED PICKS</span><h2>${esc(category)}のおすすめ</h2></div><p>レビュー数や評価などの公開データをもとに自動選定しています。</p></div><div class="grid">${rows.map(renderCard).join('')}</div></section>`;
  }).join('');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>暮らしセレクト｜一人暮らしの便利グッズを自動比較</title>
<meta name="description" content="楽天市場の商品データをもとに、一人暮らしに役立つ便利グッズをレビュー・評価などから自動比較して紹介します。">
<style>
:root{--ink:#151515;--sub:#666;--line:#e9e7e2;--paper:#f7f5f1;--white:#fff;--accent:#b6251e;--max:1180px;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic",sans-serif;color:var(--ink);background:var(--paper)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0}a{color:inherit}.wrap{max-width:var(--max);margin:auto;padding:0 24px}.top{background:#171717;color:#fff;font-size:12px;text-align:center;padding:8px}.nav{height:74px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);background:rgba(247,245,241,.92);position:sticky;top:0;z-index:10;backdrop-filter:blur(10px)}.brand{font-weight:900;font-size:21px;letter-spacing:.04em;text-decoration:none}.navlinks{display:flex;gap:18px;font-size:13px;color:#555}.navlinks a{text-decoration:none}.hero{padding:80px 0 68px;border-bottom:1px solid var(--line)}.hero-inner{display:grid;grid-template-columns:1.25fr .75fr;gap:64px;align-items:end}.kicker,.eyebrow{font-size:11px;font-weight:800;letter-spacing:.16em;color:var(--accent)}h1{font-size:clamp(38px,6vw,76px);line-height:1.02;letter-spacing:-.045em;margin:15px 0 20px}.hero p{font-size:17px;line-height:1.9;color:#555;max-width:680px}.hero-note{border-left:1px solid #bbb;padding-left:24px;font-size:13px;line-height:1.8;color:#666}.section{padding:72px 0;border-bottom:1px solid var(--line)}.section-head{display:flex;justify-content:space-between;gap:28px;align-items:end;margin-bottom:28px}.section-head h2{font-size:34px;margin:7px 0 0;letter-spacing:-.02em}.section-head p{font-size:13px;color:var(--sub);max-width:370px;line-height:1.7}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}.card{background:var(--white);border:1px solid var(--line);border-radius:16px;overflow:hidden;display:flex;flex-direction:column;min-width:0}.image{display:block;aspect-ratio:1/1;background:#fff;overflow:hidden}.image img{width:100%;height:100%;object-fit:contain;transition:transform .25s ease}.image:hover img{transform:scale(1.025)}.card-body{padding:16px;display:flex;flex-direction:column;flex:1}.tag{font-size:11px;font-weight:800;color:var(--accent);letter-spacing:.08em}.card h3{font-size:15px;line-height:1.55;margin:9px 0 10px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.summary{font-size:13px;line-height:1.65;color:#555;margin:0 0 14px}.rating{font-size:12px;color:#666;margin-top:auto}.price{font-size:22px;font-weight:900;margin:7px 0 12px}.price span{display:block;font-size:9px;font-weight:400;color:#888;margin-top:2px}.cta{display:block;text-align:center;text-decoration:none;background:#b6251e;color:#fff;padding:12px 10px;border-radius:9px;font-size:13px;font-weight:800}.about{padding:56px 0}.about-box{background:#1c1c1c;color:#fff;border-radius:20px;padding:32px}.about-box h2{margin-top:0}.about-box p{color:#ccc;line-height:1.8;font-size:13px}.footer{border-top:1px solid var(--line);padding:30px 0 48px;font-size:11px;color:#777;line-height:1.8}.footer a{color:#555}@media(max-width:900px){.hero-inner{grid-template-columns:1fr}.hero-note{display:none}.grid{grid-template-columns:repeat(2,1fr)}.section-head{display:block}.navlinks{display:none}}@media(max-width:520px){.wrap{padding:0 16px}.hero{padding:52px 0}.grid{grid-template-columns:1fr 1fr;gap:10px}.card-body{padding:12px}.card h3{font-size:13px}.summary{font-size:12px}.price{font-size:18px}.section{padding:48px 0}.section-head h2{font-size:27px}}
</style>
</head>
<body>
<div class="top">当サイトは楽天アフィリエイトプログラムを利用しています</div>
<header class="nav"><div class="wrap" style="width:100%;display:flex;align-items:center;justify-content:space-between"><a class="brand" href="#">暮らしセレクト</a><nav class="navlinks">${categories.map(c => `<a href="#${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}</nav></div></header>
<main>
<section class="hero"><div class="wrap hero-inner"><div><span class="kicker">SMART LIVING PICKS</span><h1>暮らしを軽くする、<br>ちょうどいい道具。</h1><p>楽天市場の公開商品データから、レビュー評価・レビュー数などをもとに候補を自動選定。AIが商品データを整理して、一人暮らしに取り入れやすいアイテムを紹介します。</p></div><div class="hero-note">最終更新：${esc(updatedAt)}<br>商品価格・在庫・ポイント等は変動します。購入前に楽天市場の商品ページで最新情報をご確認ください。</div></div></section>
<div class="wrap">${sections}<section class="about"><div class="about-box"><h2>このサイトの選び方</h2><p>楽天市場APIから取得した商品情報をもとに、レビュー評価・レビュー件数・商品カテゴリ等を機械的にスコアリングし、重複商品を除外して掲載候補を選定しています。紹介文は商品名やレビュー指標などの取得データをもとにAIで生成します。商品の使用感を実体験したものではありません。</p></div></section></div>
</main>
<footer class="footer"><div class="wrap">当サイトは楽天アフィリエイトプログラムを利用しており、リンク経由の購入により報酬を受け取る場合があります。<br>Supported by <a href="https://webservice.rakuten.co.jp/" target="_blank" rel="noopener">Rakuten Web Service</a></div></footer>
</body></html>`;
}

async function main() {
  console.log('Collecting Rakuten products from allowed web origin...');
  const raw = await collectProducts();
  console.log(`Collected ${raw.length} rows.`);
  const selected = selectProducts(raw);
  if (selected.length < 8) throw new Error(`Too few products selected: ${selected.length}`);
  console.log(`Selected ${selected.length} products.`);
  const products = await addAiSummaries(selected);
  const updatedAt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date());
  await fs.mkdir(path.join(process.cwd(), 'data'), { recursive: true });
  await fs.writeFile(path.join(process.cwd(), 'data', 'products.json'), JSON.stringify({ updatedAt, products }, null, 2) + '\n');
  await fs.writeFile(path.join(process.cwd(), 'index.html'), renderHtml(products, updatedAt));
  console.log('Site generated successfully.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
