#!/usr/bin/env node
/**
 * deployer-forensics — pump.fun deployer forensics
 *
 * Scores a creator wallet on the behavioural signatures of an automated
 * spam/extraction deployer, derived from a full teardown of a live one:
 * launch cadence, recycled art, self-hosted metadata, instant peaks,
 * graduation rate, and the decay-vs-peak gradient.
 *
 * Usage:
 *   node deployer-forensics.js <creator-wallet | token-mint> [options]
 *
 * Options:
 *   --json          machine-readable output
 *   --limit <n>     max launches to pull (default 1050, API caps ~1050)
 *   --chain         also query Solana RPC for balance + tx cadence
 *   --rpc <url>     RPC endpoint (default public mainnet)
 *   --no-color      disable ANSI colour
 */

'use strict';

const API = 'https://frontend-api-v3.pump.fun';
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* ── infrastructure fingerprints ───────────────────────────────────── */

// Token-discovery frontends. An image served from one of these was lifted
// from a listing UI, not uploaded by whoever launched the token.
const AGGREGATOR_CDNS = [
  'axiom-cdn.io', 'axiomtrading', 'padre.gg', 'gmgn.ai', 'photon-sol',
  'bullx.io', 'solanatracker.io', 'moonshot.com', 'uxento.io',
  'j7tracker.io', 'pumper.ink', 'launchblitz.ai', 'dexscreener.com',
];

// Where honest metadata normally lives.
const CANONICAL_METADATA = [
  'ipfs.io', 'pinata.cloud', 'mypinata.cloud', 'arweave.net', 'irys.xyz',
  'nftstorage.link', 'w3s.link', 'cf-ipfs.com', 'filebase.io', 'dweb.link',
];

const RAW_IP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/;

/* ── tiny helpers ──────────────────────────────────────────────────── */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const host = u => { try { return new URL(u).host; } catch { return null; } };
const median = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : 0;
const pct = (n, d) => d ? (100 * n / d) : 0;

function fileStem(url) {
  const h = host(url);
  if (!h) return null;
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return p.replace(/\.(webp|png|jpe?g|gif|avif)$/i, '');
  } catch { return null; }
}

function duration(sec) {
  if (sec < 90) return `${sec.toFixed(0)}s`;
  if (sec < 5400) return `${(sec / 60).toFixed(1)}min`;
  if (sec < 172800) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

const money = n => '$' + Math.round(n).toLocaleString('en-US');

/* ── colour ────────────────────────────────────────────────────────── */

let COLOR = process.stdout.isTTY && !process.argv.includes('--no-color');
const c = {
  dim: s => COLOR ? `\x1b[2m${s}\x1b[0m` : s,
  bold: s => COLOR ? `\x1b[1m${s}\x1b[0m` : s,
  red: s => COLOR ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: s => COLOR ? `\x1b[33m${s}\x1b[0m` : s,
  green: s => COLOR ? `\x1b[32m${s}\x1b[0m` : s,
  cyan: s => COLOR ? `\x1b[36m${s}\x1b[0m` : s,
  grey: s => COLOR ? `\x1b[90m${s}\x1b[0m` : s,
};

/* ── network ───────────────────────────────────────────────────────── */

async function getJSON(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Origin: 'https://pump.fun', Referer: 'https://pump.fun/' },
        signal: AbortSignal.timeout(15000),
      });
      if (r.status === 429 || r.status >= 500) { await sleep(700 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { lastErr = e; await sleep(700 * (i + 1)); }
  }
  if (lastErr) process.stderr.write(c.grey(`  (request failed: ${lastErr.message})\n`));
  return null;
}

async function rpc(url, method, params) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      if (r.status === 429) { await sleep(1200 * (i + 1)); continue; }
      const j = await r.json();
      if (j.error) { await sleep(900 * (i + 1)); continue; }
      return j.result;
    } catch { await sleep(900 * (i + 1)); }
  }
  return null;
}

async function resolveCreator(addr) {
  const coin = await getJSON(`${API}/coins/${addr}`);
  if (coin && coin.creator) return { creator: coin.creator, coin };
  return { creator: addr, coin: null };
}

async function fetchLaunches(creator, limit, onProgress) {
  const out = [];
  for (let offset = 0; out.length < limit; offset += 50) {
    const page = await getJSON(`${API}/coins?creator=${creator}&limit=50&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    onProgress?.(out.length);
    if (page.length < 50) break;
    await sleep(250);
  }
  return out.slice(0, limit);
}

/* ── signal extraction ─────────────────────────────────────────────── */

function analyse(launches) {
  const n = launches.length;
  const sorted = [...launches].sort((a, b) => a.created_timestamp - b.created_timestamp);
  const t0 = sorted[0].created_timestamp, t1 = sorted[n - 1].created_timestamp;
  const hours = Math.max((t1 - t0) / 3.6e6, 1 / 60);

  // cadence
  const gaps = [];
  for (let i = 1; i < n; i++) gaps.push((sorted[i].created_timestamp - sorted[i - 1].created_timestamp) / 1000);
  const perDay = n / (hours / 24);

  // recycled art: image filename is itself a mint address, or served from a
  // discovery-frontend CDN — either way the art belongs to another token.
  let mintNamed = 0, aggregatorHosted = 0;
  const imageHosts = new Map();
  for (const L of launches) {
    const u = L.image_uri || '';
    const h = host(u);
    if (h) imageHosts.set(h, (imageHosts.get(h) || 0) + 1);
    const stem = fileStem(u);
    if (stem && B58.test(stem)) mintNamed++;
    if (h && AGGREGATOR_CDNS.some(cdn => h.includes(cdn))) aggregatorHosted++;
  }
  const recycled = launches.filter(L => {
    const h = host(L.image_uri), stem = fileStem(L.image_uri);
    return (stem && B58.test(stem)) || (h && AGGREGATOR_CDNS.some(cdn => h.includes(cdn)));
  }).length;

  // metadata infrastructure
  const metaHosts = new Map();
  for (const L of launches) {
    const h = host(L.metadata_uri);
    if (h) metaHosts.set(h, (metaHosts.get(h) || 0) + 1);
  }
  const metaRanked = [...metaHosts.entries()].sort((a, b) => b[1] - a[1]);
  const topMeta = metaRanked[0] || [null, 0];
  const selfHosted = metaRanked.filter(([h]) =>
    !CANONICAL_METADATA.some(k => h.includes(k))).reduce((s, [, v]) => s + v, 0);
  const rawIPHosts = metaRanked.filter(([h]) => RAW_IP.test(h));

  // peak timing — the self-buy signature
  const ttp = launches
    .filter(L => L.ath_market_cap_timestamp && L.created_timestamp)
    .map(L => (L.ath_market_cap_timestamp - L.created_timestamp) / 1000)
    .filter(v => v >= 0);
  const instant = ttp.filter(v => v <= 5).length;
  const atZero = ttp.filter(v => v <= 1).length;

  // lifespan
  const life = launches
    .filter(L => L.last_trade_timestamp && L.created_timestamp)
    .map(L => (L.last_trade_timestamp - L.created_timestamp) / 1000)
    .filter(v => v >= 0);

  // graduation
  const graduated = launches.filter(L => L.complete).length;

  // content emptiness
  const noDesc = launches.filter(L => !L.description || !L.description.trim()).length;
  const noReply = launches.filter(L => !L.reply_count).length;

  // decay gradient: does collapse deepen as the peak rises?
  const BUCKETS = [[0, 5000], [5000, 7500], [7500, 15000], [15000, 50000], [50000, Infinity]];
  const decayTable = BUCKETS.map(([lo, hi]) => {
    const g = launches.filter(L => (L.ath_market_cap || 0) >= lo && (L.ath_market_cap || 0) < hi);
    if (!g.length) return null;
    return {
      label: hi === Infinity ? `${money(lo)}+` : `${money(lo)}–${money(hi)}`,
      n: g.length,
      decay: median(g.map(L => 100 - 100 * (L.usd_market_cap || 0) / (L.ath_market_cap || 1))),
      now: median(g.map(L => L.usd_market_cap || 0)),
    };
  }).filter(Boolean);

  let monotonic = false, spread = 0;
  const withData = decayTable.filter(r => r.n >= 3);
  if (withData.length >= 3) {
    monotonic = withData.every((r, i) => i === 0 || r.decay >= withData[i - 1].decay - 3);
    spread = withData[withData.length - 1].decay - withData[0].decay;
  }
  // convergence: do all buckets land at the same residual regardless of peak?
  const nows = withData.map(r => r.now).filter(v => v > 0);
  const convergence = nows.length >= 3
    ? (Math.max(...nows) - Math.min(...nows)) / (median(nows) || 1)
    : null;

  // socials
  const withTwitter = launches.filter(L => L.twitter).length;
  const handles = new Map();
  for (const L of launches) {
    const m = (L.twitter || '').match(/x\.com\/(?!i\/)([^/?#]+)\/status/i);
    if (m) handles.set(m[1], (handles.get(m[1]) || 0) + 1);
  }
  const websiteHosts = new Map();
  for (const L of launches) {
    const h = host(L.website);
    if (h) websiteHosts.set(h, (websiteHosts.get(h) || 0) + 1);
  }

  const uniq = f => new Set(launches.map(L => L[f]).filter(Boolean)).size;

  return {
    n, hours, perDay,
    first: t0, last: t1,
    medianGap: median(gaps),
    gapCount: gaps.length,
    subMinuteGaps: gaps.filter(g => g < 60).length,
    uniqueSymbols: uniq('symbol'), uniqueNames: uniq('name'), uniqueImages: uniq('image_uri'),
    recycled, mintNamed, aggregatorHosted,
    imageHosts: [...imageHosts.entries()].sort((a, b) => b[1] - a[1]),
    metaRanked, topMeta, selfHosted, rawIPHosts,
    medianTTP: median(ttp), instant, atZero, ttpCount: ttp.length,
    medianLife: median(life), deadIn5: life.filter(v => v < 300).length, lifeCount: life.length,
    graduated,
    noDesc, noReply,
    decayTable, monotonic, spread, convergence,
    withTwitter, handles: [...handles.entries()].sort((a, b) => b[1] - a[1]),
    websiteHosts: [...websiteHosts.entries()].sort((a, b) => b[1] - a[1]),
    athMedian: median(launches.map(L => L.ath_market_cap || 0)),
    nowMedian: median(launches.map(L => L.usd_market_cap || 0)),
  };
}

/* ── scoring ───────────────────────────────────────────────────────── */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function score(a) {
  const S = [];
  const add = (key, label, points, max, detail, hit) =>
    S.push({ key, label, points: Math.round(points), max, detail, hit });
  // Proportion-based signals are noise below a handful of launches — one
  // recycled image out of one launch is not a 100% recycling rate.
  const thin = a.n < 5;
  const thinNote = `not scored — needs ≥5 launches (have ${a.n})`;

  // 1. Throughput. A person launches a handful. A factory launches hundreds.
  //    Needs a real window — extrapolating a rate from two launches a minute
  //    apart yields "1440/day" and is meaningless.
  if (a.n >= 5 && a.hours >= 1) {
    add('rate', 'Launch throughput',
      clamp((a.perDay - 2) / 198 * 20, 0, 20), 20,
      `${a.perDay.toFixed(1)} launches/day over ${duration(a.hours * 3600)}`,
      a.perDay >= 20);
  } else {
    add('rate', 'Launch throughput', 0, 20,
      `not scored — needs ≥5 launches over ≥1h (have ${a.n} over ${duration(a.hours * 3600)})`, false);
  }

  // 2. Cadence. Machine-regular spacing.
  if (a.gapCount >= 4) {
    const gapPts = a.medianGap < 60 ? 15 : a.medianGap < 300 ? 11 : a.medianGap < 1800 ? 6 : a.medianGap < 7200 ? 2 : 0;
    add('cadence', 'Automated cadence', gapPts, 15,
      `median ${duration(a.medianGap)} between launches · ${a.subMinuteGaps} gaps under 60s`,
      gapPts >= 11);
  } else {
    add('cadence', 'Automated cadence', 0, 15,
      `not scored — needs ≥5 launches to measure spacing (have ${a.n})`, false);
  }

  // 3. Recycled art.
  const recycledPct = pct(a.recycled, a.n);
  if (thin) add('art', 'Recycled artwork', 0, 20, thinNote, false);
  else add('art', 'Recycled artwork',
    clamp(recycledPct / 60 * 20, 0, 20), 20,
    `${recycledPct.toFixed(1)}% of images lifted from another token or a discovery CDN` +
    (a.mintNamed ? ` · ${a.mintNamed} filenamed as a foreign mint` : ''),
    recycledPct >= 20);

  // 4. Self-hosted metadata — skips IPFS to cut launch latency.
  const selfPct = pct(a.selfHosted, a.n);
  const concentrated = a.topMeta[1] / a.n;
  if (thin) add('meta', 'Self-hosted metadata', 0, 10, thinNote, false);
  else {
    const metaPts = selfPct > 70 && concentrated > 0.7 ? 10 : selfPct > 40 ? 6 : selfPct > 15 ? 3 : 0;
    add('meta', 'Self-hosted metadata', metaPts, 10,
      a.topMeta[0]
        ? `${(concentrated * 100).toFixed(0)}% on ${a.topMeta[0]}${a.rawIPHosts.length ? ` · ${a.rawIPHosts.length} raw-IP host(s)` : ''}`
        : 'no metadata host resolved',
      metaPts >= 6);
  }

  // 5. Instant peak — the token tops out on the deployer's own buy.
  const instantPct = pct(a.instant, a.ttpCount);
  if (a.ttpCount < 5) add('peak', 'Peak-at-launch', 0, 15,
    `not scored — needs ≥5 launches with peak data (have ${a.ttpCount})`, false);
  else add('peak', 'Peak-at-launch',
    clamp(instantPct / 80 * 15, 0, 15), 15,
    `median ${duration(a.medianTTP)} to all-time high · ${pct(a.atZero, a.ttpCount).toFixed(1)}% peak at t=0`,
    instantPct >= 40);

  // 6. Graduation rate.
  const gradPct = pct(a.graduated, a.n);
  const gradPts = a.n < 15 ? 0 : gradPct < 2 ? 10 : gradPct < 5 ? 7 : gradPct < 12 ? 4 : 0;
  add('grad', 'Graduation failure', gradPts, 10,
    `${gradPct.toFixed(1)}% of curves completed (${a.graduated}/${a.n})`,
    gradPts >= 7);

  // 7. Empty listings — nothing written, nobody talking.
  const emptyPct = Math.min(pct(a.noDesc, a.n), pct(a.noReply, a.n));
  if (thin) add('empty', 'Empty listings', 0, 10, thinNote, false);
  else add('empty', 'Empty listings',
    clamp((emptyPct - 50) / 50 * 10, 0, 10), 10,
    `${pct(a.noDesc, a.n).toFixed(0)}% no description · ${pct(a.noReply, a.n).toFixed(0)}% zero replies`,
    emptyPct >= 85);

  // 8. Extraction gradient — the strongest single tell. The better a launch
  //    runs, the harder it is dumped, and every bucket lands on the same floor.
  let gradientPts = 0, gradientDetail = 'not enough launches to measure';
  if (a.decayTable.filter(r => r.n >= 3).length >= 3) {
    if (a.monotonic && a.spread > 25) { gradientPts = 10; gradientDetail = `decay climbs ${a.spread.toFixed(0)} points with peak size`; }
    else if (a.monotonic && a.spread > 10) { gradientPts = 6; gradientDetail = `decay climbs ${a.spread.toFixed(0)} points with peak size`; }
    else { gradientDetail = 'no consistent decay/peak relationship'; }
    if (a.convergence !== null && a.convergence < 0.25) {
      gradientPts = Math.min(10, gradientPts + 3);
      gradientDetail += ` · all buckets converge near ${money(median(a.decayTable.filter(r => r.n >= 3).map(r => r.now)))}`;
    }
  }
  add('gradient', 'Extraction gradient', gradientPts, 10, gradientDetail, gradientPts >= 6);

  const total = S.reduce((s, x) => s + x.points, 0);
  // Only count signals that were actually measurable, so an unscorable
  // signal lowers confidence rather than silently reading as "clean".
  const scored = S.filter(x => !/^not scored/.test(x.detail));
  const max = scored.reduce((s, x) => s + x.max, 0) || 1;
  const pctScore = Math.round(100 * total / max);

  const band =
    pctScore >= 75 ? { label: 'EXTRACTION FACTORY', color: c.red, verdict: 'Automated spam deployer. Launches exist to be exited, not held.' } :
    pctScore >= 50 ? { label: 'HIGH RISK', color: c.red, verdict: 'Strong automation signature. Treat every launch as adversarial.' } :
    pctScore >= 25 ? { label: 'ELEVATED', color: c.yellow, verdict: 'Some industrial patterns present. Verify before entering.' } :
                     { label: 'NO FACTORY SIGNATURE', color: c.green, verdict: 'Does not match the automated-deployer profile on these signals.' };

  const notes = [];
  const unscored = S.length - scored.length;
  if (a.n < 20) notes.push(`Low confidence: only ${a.n} launch${a.n === 1 ? '' : 'es'} on record.`);
  if (unscored) notes.push(`${unscored} of ${S.length} signals could not be measured and are excluded from the total.`);
  if (gradPct >= 20) notes.push(`Mitigating: ${gradPct.toFixed(0)}% of this creator's curves completed — well above a spam deployer.`);

  return { signals: S, total, max, pctScore, band, notes, scoredCount: scored.length };
}

/* ── reporting ─────────────────────────────────────────────────────── */

const W = 74;
const rule = ch => c.grey(ch.repeat(W));
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));

function bar(points, max) {
  const filled = max ? Math.round(points / max * 12) : 0;
  const s = '█'.repeat(filled) + c.grey('·'.repeat(12 - filled));
  return points / max > 0.6 ? c.red(s) : points / max > 0.3 ? c.yellow(s) : c.green(s);
}

function report(target, creator, a, sc, coin, chain) {
  const L = console.log;
  L('');
  L(rule('━'));
  L(c.bold('  DEPLOYER-FORENSICS') + c.grey('  ·  pump.fun deployer forensics'));
  L(rule('━'));
  L('');
  L(`  ${c.grey('creator')}  ${creator}`);
  if (coin) L(`  ${c.grey('via    ')}  ${coin.symbol || '?'} (${target.slice(0, 12)}…)`);
  L(`  ${c.grey('window ')}  ${new Date(a.first).toISOString().slice(0, 16).replace('T', ' ')} → ${new Date(a.last).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  L(`  ${c.grey('sample ')}  ${a.n} launches`);
  if (chain) L(`  ${c.grey('balance')}  ${chain.sol.toFixed(3)} SOL${chain.txRate ? `  ·  ${chain.txRate.toFixed(1)} tx/min  ·  ${chain.failPct.toFixed(1)}% failed` : ''}`);
  L('');

  // ── verdict banner
  const b = sc.band;
  L('  ' + b.color(c.bold(`▌ ${b.label}`)) + c.grey(`   ${sc.pctScore}/100`));
  L('  ' + c.grey('▌ ') + b.verdict);
  for (const note of sc.notes) L('  ' + c.grey('▌ ') + c.yellow(note));
  L('');
  L(rule('─'));
  L('');

  // ── signals
  L(c.bold('  SIGNALS'));
  L('');
  for (const s of sc.signals) {
    const flag = s.hit ? c.red('●') : c.grey('○');
    L(`  ${flag} ${pad(s.label, 22)} ${bar(s.points, s.max)} ${c.grey(String(s.points).padStart(2) + '/' + s.max)}`);
    L(`    ${c.grey(s.detail)}`);
  }
  L('');

  // ── decay table
  if (a.decayTable.length >= 2) {
    L(rule('─'));
    L('');
    L(c.bold('  DECAY BY PEAK') + c.grey('   does a good launch escape?'));
    L('');
    L('  ' + c.grey(pad('peak market cap', 22) + pad('n', 6) + pad('median decay', 15) + 'median now'));
    for (const r of a.decayTable) {
      const d = r.decay > 80 ? c.red : r.decay > 50 ? c.yellow : c.green;
      L('  ' + pad(r.label, 22) + c.grey(pad(String(r.n), 6)) +
        d(pad(r.decay.toFixed(1) + '%', 15)) + c.cyan(money(r.now)));
    }
    if (a.convergence !== null && a.convergence < 0.25) {
      L('');
      L(c.grey(`  → peak varies widely; the endpoint does not. Every bucket lands near ${money(median(a.decayTable.filter(r => r.n >= 3).map(r => r.now)))}.`));
    }
    L('');
  }

  // ── infrastructure
  L(rule('─'));
  L('');
  L(c.bold('  INFRASTRUCTURE'));
  L('');
  if (a.metaRanked.length) {
    L(`  ${c.grey('metadata')}   ` + a.metaRanked.slice(0, 3).map(([h, v]) => `${h} ${c.grey('×' + v)}`).join('  '));
  }
  if (a.imageHosts.length) {
    L(`  ${c.grey('images  ')}   ` + a.imageHosts.slice(0, 3).map(([h, v]) => `${h} ${c.grey('×' + v)}`).join('  '));
  }
  if (a.websiteHosts.length) {
    L(`  ${c.grey('website ')}   ` + a.websiteHosts.slice(0, 3).map(([h, v]) => `${h} ${c.grey('×' + v)}`).join('  '));
  }
  L(`  ${c.grey('tickers ')}   ${a.uniqueSymbols}/${a.n} unique  ·  ${c.grey('images')} ${a.uniqueImages}/${a.n} unique`);
  if (a.handles.length) {
    L(`  ${c.grey('cites   ')}   ${a.handles.length} X accounts, top: ` +
      a.handles.slice(0, 4).map(([h, v]) => `@${h} ${c.grey('×' + v)}`).join('  '));
  }
  L('');
  L(rule('━'));
  L('');
}

/* ── main ──────────────────────────────────────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  const target = argv.find(x => !x.startsWith('--'));
  const flag = k => argv.includes(`--${k}`);
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

  if (!target) {
    console.log(`
  deployer-forensics — pump.fun deployer forensics

  Scores a creator wallet against the behavioural signature of an
  automated extraction deployer. Accepts a creator address or any
  token mint (the creator is resolved automatically).

  usage:
    node deployer-forensics.js <creator-wallet | token-mint> [options]

  options:
    --json           machine-readable output
    --limit <n>      max launches to pull        (default 1050)
    --chain          also query Solana RPC for balance + tx cadence
    --rpc <url>      RPC endpoint                (default public mainnet)
    --no-color       disable ANSI colour

  example:
    node deployer-forensics.js <creator-wallet> --chain
`);
    process.exit(1);
  }

  if (!B58.test(target)) {
    console.error(c.red(`  not a valid base58 Solana address: ${target}`));
    process.exit(1);
  }

  const json = flag('json');
  if (json) COLOR = false;
  const limit = parseInt(opt('limit', '1050'), 10);

  if (!json) process.stderr.write(c.grey('  resolving creator…\n'));
  const { creator, coin } = await resolveCreator(target);

  if (!json) process.stderr.write(c.grey('  pulling launch history…'));
  const launches = await fetchLaunches(creator, limit, n => {
    if (!json) process.stderr.write(c.grey(`\r  pulling launch history… ${n}`));
  });
  if (!json) process.stderr.write('\r' + ' '.repeat(46) + '\r');

  if (!launches.length) {
    console.error(c.yellow(`\n  No pump.fun launches found for ${creator}.`) +
      c.grey('\n  This address has not deployed on pump.fun, or the API has no record of it.\n'));
    process.exit(2);
  }

  const a = analyse(launches);
  const sc = score(a);

  let chain = null;
  if (flag('chain')) {
    const rpcUrl = opt('rpc', DEFAULT_RPC);
    if (!json) process.stderr.write(c.grey('  querying chain…\n'));
    const bal = await rpc(rpcUrl, 'getBalance', [creator]);
    const sigs = await rpc(rpcUrl, 'getSignaturesForAddress', [creator, { limit: 1000 }]);
    if (bal || sigs) {
      chain = { sol: (bal?.value || 0) / 1e9 };
      if (Array.isArray(sigs) && sigs.length > 1) {
        const times = sigs.map(s => s.blockTime).filter(Boolean).sort((x, y) => x - y);
        const span = (times.at(-1) - times[0]) / 60;
        chain.txRate = span > 0 ? sigs.length / span : 0;
        chain.failPct = pct(sigs.filter(s => s.err).length, sigs.length);
        chain.sampled = sigs.length;
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({
      target, creator,
      viaMint: coin ? { mint: target, symbol: coin.symbol, name: coin.name } : null,
      window: { from: a.first, to: a.last, hours: +a.hours.toFixed(2) },
      sample: a.n,
      score: sc.pctScore, band: sc.band.label, verdict: sc.band.verdict, notes: sc.notes,
      signals: sc.signals.map(s => ({ key: s.key, label: s.label, points: s.points, max: s.max, hit: s.hit, detail: s.detail })),
      metrics: {
        launchesPerDay: +a.perDay.toFixed(2),
        medianGapSeconds: +a.medianGap.toFixed(1),
        recycledArtPct: +pct(a.recycled, a.n).toFixed(2),
        mintNamedImages: a.mintNamed,
        selfHostedMetadataPct: +pct(a.selfHosted, a.n).toFixed(2),
        topMetadataHost: a.topMeta[0],
        medianSecondsToPeak: +a.medianTTP.toFixed(1),
        peakAtZeroPct: +pct(a.atZero, a.ttpCount).toFixed(2),
        graduationPct: +pct(a.graduated, a.n).toFixed(2),
        medianLifespanSeconds: +a.medianLife.toFixed(1),
        uniqueSymbols: a.uniqueSymbols,
        medianAth: Math.round(a.athMedian),
        medianNow: Math.round(a.nowMedian),
        decayByPeak: a.decayTable.map(r => ({ bucket: r.label, n: r.n, medianDecayPct: +r.decay.toFixed(1), medianNow: Math.round(r.now) })),
        convergenceRatio: a.convergence === null ? null : +a.convergence.toFixed(3),
      },
      chain,
    }, null, 2));
  } else {
    report(target, creator, a, sc, coin, chain);
  }
}

main().catch(e => { console.error(c.red('  error: ' + e.message)); process.exit(1); });
