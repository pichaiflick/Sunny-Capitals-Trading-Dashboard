const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

// ══ App version + auto-update ════════════════════════════
// 1. Bump APP_VERSION when you cut a new RELEASE (shows the update banner).
// 2. Set UPDATE_REPO to your GitHub repo to switch updates ON. Until then it stays off.
const APP_VERSION   = '1.0.0';
const UPDATE_REPO   = 'YOUR_GITHUB_USERNAME/sunny-capitals-dashboard'; // e.g. 'sunny/sunny-capitals'
const UPDATE_BRANCH = 'main';
const UPDATE_BASE   = UPDATE_REPO.startsWith('YOUR_GITHUB')
  ? ''  // not configured yet → auto-update + version check stay disabled
  : `https://raw.githubusercontent.com/${UPDATE_REPO}/${UPDATE_BRANCH}/`;

// ── These get replaced by setup wizard ──────────────────
let NOTION_TOKEN    = 'YOUR_NOTION_TOKEN_HERE';
let DATABASE_ID     = 'YOUR_DATABASE_ID_HERE';
let ANTHROPIC_API_KEY = ''; // set via config.json (anthropicKey) or the /setup wizard — never hardcode secrets here
// ────────────────────────────────────────────────────────

// Load config if it exists (written by setup wizard)
const configPath = path.join(__dirname, 'config.json');
let appConfig = {};
if (fs.existsSync(configPath)) {
  try {
    appConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (appConfig.notionToken)  NOTION_TOKEN      = appConfig.notionToken;
    if (appConfig.databaseId)   DATABASE_ID       = appConfig.databaseId;
    if (appConfig.anthropicKey) ANTHROPIC_API_KEY = appConfig.anthropicKey;
  } catch(e) { console.warn('⚠️  Could not read config.json:', e.message); }
}

// Dashboard HTML kept in memory so the auto-updater can refresh it live
let dashboardHtml = '';
try { dashboardHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'); } catch(e) {}

function httpsPost(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname, port: 443, path: urlPath, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('Bad JSON: ' + data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpsGet(hostname, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, port: 443, path: urlPath, method: 'GET', headers,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('Bad JSON: ' + data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Fetch raw text over HTTPS (used by the auto-updater). Resolves {status, body}.
function httpsGetText(fullUrl) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(fullUrl); } catch(e) { return reject(e); }
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'SunnyCapitals' } }, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// On launch, pull the latest dashboard.html from GitHub (silent UI auto-update).
// Falls back to the local copy if offline/unreachable; validates before applying.
async function selfUpdate() {
  if (!UPDATE_BASE || appConfig.autoUpdate === false) return;
  try {
    const r = await httpsGetText(UPDATE_BASE + 'dashboard.html');
    if (r.status === 200 && r.body && r.body.length > 50000 && r.body.includes('</html>')) {
      if (r.body !== dashboardHtml) {
        dashboardHtml = r.body;
        try { fs.writeFileSync(path.join(__dirname, 'dashboard.html'), r.body); } catch(e) {}
        console.log('⬇️  Dashboard updated to the latest version.');
      } else {
        console.log('✓ Dashboard is up to date.');
      }
    }
  } catch(e) { /* offline / unreachable — keep the local copy */ }
}

function getNotionHeaders() {
  return {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
}

const notionPost = (p, b) => httpsPost('api.notion.com', p, getNotionHeaders(), b);
const notionGet  = (p)    => httpsGet('api.notion.com', p, getNotionHeaders());

const callClaude = (prompt) => httpsPost(
  'api.anthropic.com', '/v1/messages',
  { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
  { model: 'claude-sonnet-4-5', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }
);

const nameCache = {};
const firmCache = {};

// Pull a numeric value from a Notion property regardless of type
function propNum(p) {
  if (!p) return null;
  if (p.type === 'number') return p.number;
  if (p.type === 'formula' && p.formula?.type === 'number') return p.formula.number;
  if (p.type === 'rollup' && p.rollup?.type === 'number') return p.rollup.number;
  // Text-based fields (rich_text / title / select): parse a number out of the string,
  // e.g. "93,818.61" -> 93818.61, "8%" -> 8.
  let txt = null;
  if (p.type === 'rich_text') txt = p.rich_text?.map(t => t.plain_text).join('');
  else if (p.type === 'title') txt = p.title?.map(t => t.plain_text).join('');
  else if (p.type === 'select') txt = p.select?.name;
  if (txt) {
    const n = parseFloat(String(txt).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? null : n;
  }
  return null;
}

// Extract account targets/limits from any property bag (account page OR trade row),
// matching field names loosely (case/spacing/symbol insensitive).
function extractMeta(props) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = {};
  for (const [k, v] of Object.entries(props || {})) map[norm(k)] = v;
  const find = (...needles) => {
    for (const n of needles) {
      const target = norm(n);
      if (map[target] != null) { const x = propNum(map[target]); if (x != null) return x; }
    }
    for (const n of needles) {
      const target = norm(n);
      for (const key of Object.keys(map)) {
        if (key.includes(target)) { const x = propNum(map[key]); if (x != null) return x; }
      }
    }
    return null;
  };
  return {
    initialBalance: find('initial balance', 'starting balance', 'account size', 'starting capital'),
    currentBalance: find('current balance', 'currentbalance', 'equity'),
    profitTarget:   find('profit target', 'target', 'profit goal'),
    maxDrawdownPct: find('max drawdown', 'maximum drawdown', 'total drawdown', 'drawdown'),
    maxDailyLossPct:find('max daily loss', 'daily loss', 'daily drawdown'),
  };
}

function metaHasData(m) {
  return !!(m && (m.initialBalance || m.profitTarget || m.maxDrawdownPct || m.maxDailyLossPct));
}

async function resolvePageName(pageId) {
  if (nameCache[pageId]) return nameCache[pageId];
  try {
    const r = await notionGet(`/v1/pages/${pageId}`);
    if (r.status !== 200) return 'Unknown';
    const props = r.body.properties || {};
    let name = 'Unknown';
    let firm = '';
    for (const prop of Object.values(props)) {
      if (prop.type === 'title' && prop.title?.length > 0) {
        name = prop.title.map(t => t.plain_text).join('');
        break;
      }
    }
    const firmProp = props['Firm'] || props['firm'] || props['Prop Firm'] || props['Broker'] || null;
    if (firmProp) {
      if (firmProp.type === 'select')          firm = firmProp.select?.name || '';
      else if (firmProp.type === 'rich_text')  firm = firmProp.rich_text?.map(t=>t.plain_text).join('') || '';
      else if (firmProp.type === 'multi_select') firm = firmProp.multi_select?.map(s=>s.name).join(', ') || '';
    }

    // Pull account-level limits (loose field-name matching)
    const accountMeta = extractMeta(props);
    // Capture Phase and Status (select fields) for grouping & projections
    const selName = (p) => (p && p.type === 'select') ? (p.select?.name || '') : '';
    accountMeta.phase  = selName(props['Phase']);
    accountMeta.status = selName(props['Status']);

    nameCache[pageId] = name.replace(/^["']+|["']+$/g, '').trim();
    firmCache[pageId] = firm.replace(/^["']+|["']+$/g, '').trim();
    // Store account meta separately
    if (!global.acctMetaCache) global.acctMetaCache = {};
    global.acctMetaCache[nameCache[pageId]] = accountMeta;

    return nameCache[pageId];
  } catch(e) { return 'Unknown'; }
}

async function fetchAllTrades() {
  let allPages = [];
  let cursor = null;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await notionPost(`/v1/databases/${DATABASE_ID}/query`, body);
    if (r.status !== 200) throw new Error(`Notion ${r.status}: ${JSON.stringify(r.body)}`);
    allPages = allPages.concat(r.body.results || []);
    cursor = r.body.has_more ? r.body.next_cursor : null;
  } while (cursor);

  const accountIds = new Set();
  for (const page of allPages) {
    const acct = page.properties['Account'];
    if (acct?.type === 'relation') (acct.relation || []).forEach(rel => accountIds.add(rel.id));
  }
  if (accountIds.size > 0) {
    console.log(`🔗 Resolving ${accountIds.size} account(s)...`);
    await Promise.all([...accountIds].map(id => resolvePageName(id)));
  }
  for (const page of allPages) {
    const acct = page.properties['Account'];
    if (acct?.type === 'relation' && acct.relation?.length > 0) {
      page._accountName = acct.relation.map(r => nameCache[r.id] || 'Unknown').join(', ');
      page._firmName    = acct.relation.map(r => firmCache[r.id] || '').filter(Boolean).join(', ');
    } else {
      page._accountName = 'No Account';
      page._firmName    = '';
    }
    page._pageId = page.id;
    page._accountMeta = global.acctMetaCache?.[page._accountName] || null;
    // Fallback: if the linked account page had no targets/limits (or there is no
    // account relation), read them straight off the trade row's own properties.
    if (!metaHasData(page._accountMeta)) {
      const rowMeta = extractMeta(page.properties);
      if (metaHasData(rowMeta)) {
        page._accountMeta = rowMeta;
        if (!global.acctMetaCache) global.acctMetaCache = {};
        // remember it for this account name so all its trades share it
        if (page._accountName) global.acctMetaCache[page._accountName] = rowMeta;
      }
    }
  }
  return allPages;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 1e6) { req.destroy(); reject(new Error('Request body too large')); } // 1 MB cap
    });
    req.on('end', () => resolve(body));
  });
}

function isSetupComplete() {
  // Check config.json first (setup wizard creates this)
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.setupDone && cfg.notionToken && cfg.databaseId) return true;
    } catch(e) {}
  }
  // Fall back to checking if tokens look real (not placeholders)
  return NOTION_TOKEN !== 'YOUR_NOTION_TOKEN_HERE' && DATABASE_ID !== 'YOUR_DATABASE_ID_HERE';
}

const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];

  // Only allow same-machine origins. A request with no Origin header is a direct
  // browser navigation / same-origin fetch (the dashboard itself) — allowed.
  const origin = req.headers.origin;
  const localOrigin = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (origin && localOrigin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(localOrigin ? 204 : 403);
    res.end();
    return;
  }
  // Block cross-origin calls to any state-changing / data endpoint from other
  // websites (CSRF protection — covers /api/* and the /setup/* config routes).
  if (origin && !localOrigin && (pathname.startsWith('/api/') || pathname.startsWith('/setup/'))) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Cross-origin requests are not allowed.' }));
    return;
  }

  // ── Setup routes (always available) ─────────────────

  if (pathname === '/setup') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'setup.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch(e) { res.writeHead(404); res.end('setup.html not found'); }
    return;
  }

  if (pathname === '/setup/test-token') {
    try {
      const body = await readBody(req);
      const { token } = JSON.parse(body);
      const r = await httpsGet('api.notion.com', '/v1/users/me', {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
      });
      if (r.status === 200) {
        const workspace = r.body.name || r.body.bot?.workspace_name || 'your workspace';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, workspace }));
      } else {
        throw new Error(r.body?.message || 'Invalid token — check you copied it correctly');
      }
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/setup/test-db') {
    try {
      const body = await readBody(req);
      const { token, dbId } = JSON.parse(body);
      const headers = {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      };
      const r = await httpsPost('api.notion.com', `/v1/databases/${dbId}/query`, headers, { page_size: 100 });
      if (r.status === 200) {
        const count = r.body?.results?.length || 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, count }));
      } else {
        const msg = r.body?.message || 'Could not access database';
        const friendly = r.status === 404
          ? 'Database not found — make sure you added the integration to this database in Notion (··· → Add connections)'
          : r.status === 401
          ? 'Unauthorised — check your token is correct'
          : msg;
        throw new Error(friendly);
      }
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/setup/save') {
    try {
      const body = await readBody(req);
      const { token, dbId, anthropicKey, userName } = JSON.parse(body);
      if (!token || !dbId) throw new Error('Token and database ID are required');

      // Save everything to config.json — server reads this on startup
      const config = {
        notionToken:   token,
        databaseId:    dbId,
        anthropicKey:  anthropicKey || '',
        userName:      userName || '',
        setupDone:     true,
        setupDate:     new Date().toISOString(),
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('💾 Config saved to config.json');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));

      // Restart so new config loads
      console.log('🔄 Restarting server with new config...');
      setTimeout(() => process.exit(0), 500);
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // ── Main app routes ───────────────────────────────────

  if (pathname === '/bg.mp4') {
    try {
      const videoPath = path.join(__dirname, 'bg.mp4');
      const stat = fs.statSync(videoPath);
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunkSize = (end - start) + 1;
        const file = fs.createReadStream(videoPath, { start, end });
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'video/mp4',
        });
        file.pipe(res);
      } else {
        res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
        fs.createReadStream(videoPath).pipe(res);
      }
    } catch(e) { res.writeHead(404); res.end('Video not found'); }
    return;
  }

  if (pathname === '/api/trades') {
    try {
      console.log('📊 Fetching trades from Notion...');
      const pages = await fetchAllTrades();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, pages }));
      console.log(`✅ Returned ${pages.length} trade(s)`);
    } catch(e) {
      console.error('❌ Trades error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/review') {
    try {
      if (!ANTHROPIC_API_KEY) throw new Error('No Anthropic API key set. Run /setup to add one.');
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      console.log('🤖 Generating AI review...');
      const result = await callClaude(parsed.prompt);
      if (result.status !== 200) throw new Error(`Anthropic error ${result.status}: ${result.body?.error?.message || JSON.stringify(result.body)}`);
      const reviewData = {
        content:    result.body.content,
        savedAt:    new Date().toISOString(),
        tradeCount: parsed.tradeCount || 0,
        account:    parsed.account || 'All Accounts',
      };
      try { fs.writeFileSync(path.join(__dirname, 'last_review.json'), JSON.stringify(reviewData)); console.log('💾 Review saved'); }
      catch(e) { console.warn('⚠️  Could not save review:', e.message); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, content: result.body.content }));
      console.log('✅ AI review done');
    } catch(e) {
      console.error('❌ Review error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/review/saved') {
    try {
      const filepath = path.join(__dirname, 'last_review.json');
      if (!fs.existsSync(filepath)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, review: null }));
        return;
      }
      const saved = fs.readFileSync(filepath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, review: JSON.parse(saved) }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, review: null }));
    }
    return;
  }

  if (pathname === '/api/review/clear') {
    try {
      const filepath = path.join(__dirname, 'last_review.json');
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/page') {
    try {
      let pageId = (req.url.split('?id=')[1] || '').split('&')[0];
      pageId = decodeURIComponent(pageId).replace(/[^a-f0-9-]/gi, ''); // Notion IDs are UUIDs only
      if (!/^[a-f0-9-]{16,40}$/i.test(pageId)) throw new Error('Invalid page ID');
      const r = await httpsGet('api.notion.com', `/v1/blocks/${pageId}/children?page_size=100`, getNotionHeaders());
      if (r.status !== 200) throw new Error(`Notion ${r.status}`);
      const blocks = r.body.results || [];
      const images = blocks
        .filter(b => b.type === 'image')
        .map(b => ({ url: b.image?.file?.url || b.image?.external?.url || null, caption: b.image?.caption?.map(c => c.plain_text).join('') || '' }))
        .filter(img => img.url);
      const notes = blocks
        .filter(b => ['paragraph','heading_1','heading_2','heading_3','bulleted_list_item','numbered_list_item','quote','callout'].includes(b.type))
        .map(b => (b[b.type]?.rich_text || []).map(t => t.plain_text).join(''))
        .filter(t => t.trim().length > 0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, images, notes }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/version') {
    let latest = null, notes = '', url = '';
    if (UPDATE_BASE) {
      try {
        const r = await httpsGetText(UPDATE_BASE + 'version.json');
        if (r.status === 200) { const v = JSON.parse(r.body); latest = v.version || null; notes = v.notes || ''; url = v.url || ''; }
      } catch(e) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ current: APP_VERSION, latest, notes, url }));
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    // Redirect to setup if not configured
    if (!isSetupComplete()) {
      res.writeHead(302, { 'Location': '/setup' });
      res.end();
      return;
    }
    try {
      const html = dashboardHtml || fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch(e) { res.writeHead(404); res.end('dashboard.html not found'); }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║   Sunny Capitals — Running port 3000   ║');
  console.log('╠════════════════════════════════════════╣');
  console.log('║  Open: http://localhost:3000           ║');
  console.log('║  Stop: Ctrl+C                          ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  if (!isSetupComplete()) {
    console.log('⚙️  First time setup required');
    console.log('   Opening setup wizard at http://localhost:3000/setup');
  } else {
    console.log(`✅ Notion connected — database: ${DATABASE_ID.slice(0,8)}...`);
    if (ANTHROPIC_API_KEY) console.log('✅ AI Review enabled');
    else console.log('⚠️  AI Review disabled — run /setup to add key');
  }
  console.log(`   Version ${APP_VERSION}${UPDATE_BASE ? ' · auto-update on' : ' · auto-update off (set UPDATE_REPO)'}`);
  console.log('');
  selfUpdate(); // pull the latest dashboard.html from GitHub if configured
  const open = process.platform === 'win32' ? 'start' :
               process.platform === 'darwin' ? 'open' : 'xdg-open';
  require('child_process').exec(`${open} http://localhost:3000`);
});
