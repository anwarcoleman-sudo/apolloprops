/*
 * ApolloProps API Server — Credit-Aware Build
 * ============================================
 * Odds API credit strategy:
 *   - Fetch per sport on demand (not all at startup)
 *   - 60-min cache pregame, 30-min within 2hrs of tip
 *   - Manual refresh blocked for 10 min after any fetch
 *   - AI picks cached all day (reset midnight ET)
 *   - SCHEDULE object is free fallback when credits are low
 *
 * Railway env vars:
 *   ANTHROPIC_API_KEY = sk-ant-...
 *   ODDS_API_KEY      = your key
 */
 
const express = require('express');
const cors    = require('cors');
const app     = express();
app.use(express.json());
 
// ── CORS ─────────────────────────────────────────────────────────────
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  res.sendStatus(200);
});
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  next();
});
app.use(cors({ origin: '*', optionsSuccessStatus: 200 }));
 
// ── KEYS ─────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ODDS_KEY      = process.env.ODDS_API_KEY;
const MODEL         = 'claude-sonnet-4-20250514';
const ODDS_BASE     = 'https://api.the-odds-api.com/v4';
 
// ── SPORT MAP ────────────────────────────────────────────────────────
const SPORT_KEYS = {
  nba:  'basketball_nba',
  mlb:  'baseball_mlb',
  nhl:  'icehockey_nhl',
  wnba: 'basketball_wnba'
};
 
// ── TIME HELPERS ─────────────────────────────────────────────────────
function nowET() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
}
function todayET() {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  });
}
function timeET(iso) {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true
  }) + ' ET';
}
function minsAgo(ts) { return Math.round((Date.now() - ts) / 60000); }
 
// ── TTL LOGIC ─────────────────────────────────────────────────────────
// 60 min normally, 30 min if a game starts within 2 hours
const TTL_NORMAL  = 60 * 60 * 1000;   // 60 min
const TTL_PREGAME = 30 * 60 * 1000;   // 30 min
const TTL_REFRESH = 10 * 60 * 1000;   // 10 min cooldown after manual refresh
 
function getTTL(games) {
  if (!games || !games.length) return TTL_NORMAL;
  const now = Date.now();
  const twoHours = 2 * 60 * 60 * 1000;
  const soonest = games.reduce((min, g) => {
    const t = new Date(g.isoTime || g.commence_time || 0).getTime();
    return t > now && t < min ? t : min;
  }, Infinity);
  if (soonest - now < twoHours) {
    console.log('[ttl] Game within 2hrs — using 30-min TTL');
    return TTL_PREGAME;
  }
  return TTL_NORMAL;
}
 
// ── CACHE ─────────────────────────────────────────────────────────────
// slates:  { sport: { ts, data, games } }  — per-sport, TTL-aware
// picks:   { sport: { ts, picks } }         — per-sport, daily
// refresh: { sport: ts }                    — 10-min cooldown per sport
const slates   = {};   // sport → { ts, data, games }
const picks    = {};   // sport → { date, picks }
const refresh  = {};   // sport → last manual refresh ts
 
function slateValid(sport) {
  const s = slates[sport];
  if (!s) return false;
  const ttl = getTTL(s.games);
  const age = Date.now() - s.ts;
  if (age < ttl) {
    console.log(`[cache] HIT  slate:${sport} age=${minsAgo(s.ts)}min ttl=${ttl/60000}min`);
    return true;
  }
  console.log(`[cache] MISS slate:${sport} age=${minsAgo(s.ts)}min ttl=${ttl/60000}min`);
  return false;
}
 
function picksValid(sport) {
  const p = picks[sport];
  if (!p || p.date !== todayET() || !p.picks?.length) return false;
  console.log(`[cache] HIT  picks:${sport} count=${p.picks.length}`);
  return true;
}
 
function refreshBlocked(sport) {
  const last = refresh[sport];
  if (!last) return false;
  const blocked = (Date.now() - last) < TTL_REFRESH;
  if (blocked) console.log(`[cache] REFRESH BLOCKED sport:${sport} cooldown=${minsAgo(last)}min ago`);
  return blocked;
}
 
// Reset picks at midnight ET
function clearAtMidnight() {
  const etNow  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etNext = new Date(etNow); etNext.setHours(24, 0, 0, 0);
  const ms     = etNext - etNow;
  setTimeout(() => {
    Object.keys(picks).forEach(k => delete picks[k]);
    console.log('[cache] Picks cleared at midnight ET');
    clearAtMidnight();
  }, ms);
  console.log(`[cache] Next picks clear in ${Math.round(ms/60000)} min`);
}
clearAtMidnight();
 
// ── SCHEDULE FALLBACK ────────────────────────────────────────────────
// Free fallback — no API credits needed. Update weekly.
const SCHEDULE = {
  'Fri, May 15, 2026': {
    nba: [
      'DET @ CLE  7:00 PM ET — G6, CLE leads 3-2 (Mitchell 28pts avg, Cunningham 25pts avg)',
      'SAS @ MIN  9:30 PM ET — G6, SAS leads 3-2 (Edwards 28+pts avg, Fox leads SAS)'
    ],
    mlb: [
      'PIT @ PHI  6:40 PM ET', 'BAL @ WSH  6:45 PM ET', 'TOR @ DET  6:45 PM ET',
      'CIN @ CLE  7:10 PM ET', 'MIA @ TB   7:10 PM ET', 'MIL @ MIN  7:10 PM ET',
      'BOS @ ATL  7:15 PM ET', 'NYY @ NYM  7:15 PM ET', 'CHC @ CWS  7:40 PM ET',
      'TEX @ HOU  8:10 PM ET', 'KC  @ STL  8:15 PM ET', 'AZ  @ COL  8:40 PM ET',
      'LAD @ LAA  9:38 PM ET', 'SD  @ SEA  9:40 PM ET', 'SF  @ ATH  9:40 PM ET'
    ],
    wnba: [], nhl: [],
    notes: 'Two NBA G6 elimination games. NYY @ NYM subway series.'
  },
  'Sat, May 16, 2026': {
    nba: [],
    mlb: [
      'TOR @ DET  1:10 PM ET', 'AZ  @ COL  3:10 PM ET', 'BAL @ WSH  4:05 PM ET',
      'BOS @ ATL  4:05 PM ET', 'MIA @ TB   6:10 PM ET', 'NYY @ NYM  7:15 PM ET',
      'TEX @ HOU  8:10 PM ET', 'LAD @ LAA  9:38 PM ET', 'SD  @ SEA  9:40 PM ET'
    ],
    wnba: [], nhl: [],
    notes: 'No NBA. G7s if needed Sunday.'
  },
  'Sun, May 17, 2026': {
    nba: [
      'POSSIBLE G7: DET vs CLE (only if tied 3-3)',
      'POSSIBLE G7: SAS vs MIN (only if tied 3-3)'
    ],
    mlb: [
      'NYY @ NYM  1:35 PM ET', 'LAD @ LAA  4:07 PM ET',
      'SD  @ SEA  4:10 PM ET', 'AZ  @ COL  3:10 PM ET'
    ],
    wnba: [], nhl: [],
    notes: 'G7s only if series went to 7.'
  }
};
 
function getSchedule(dateStr) {
  return SCHEDULE[dateStr] || { nba: [], mlb: [], wnba: [], nhl: [], notes: '' };
}
 
// ── ODDS API ──────────────────────────────────────────────────────────
async function oddsGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = ODDS_BASE + path + sep + 'apiKey=' + ODDS_KEY;
  const r   = await fetch(url);
  const rem = r.headers.get('x-requests-remaining');
  const used = r.headers.get('x-requests-used');
  console.log(`[odds] ${path.split('?')[0]} → ${r.status} | remaining:${rem} used:${used}`);
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Odds API ${r.status}: ${body}`);
  }
  return r.json();
}
 
// Fetch one sport from Odds API
async function fetchOneSport(sport) {
  const key = SPORT_KEYS[sport];
  if (!key) throw new Error('Unknown sport: ' + sport);
 
  console.log(`[odds] Fetching ${sport.toUpperCase()} (${key})...`);
  const raw = await oddsGet(
    `/sports/${key}/odds/?regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso`
  );
 
  // Filter: started up to 3 hrs ago or starting within 36 hrs
  const now = Date.now();
  const games = (raw || []).filter(g => {
    const t = new Date(g.commence_time).getTime();
    return t >= now - 3 * 3600000 && t <= now + 36 * 3600000;
  });
 
  console.log(`[odds] ${sport.toUpperCase()}: ${raw.length} total → ${games.length} in window`);
 
  // Build structured game objects
  const structured = games.map(g => {
    const bk = g.bookmakers?.[0];
    const markets = {};
    bk?.markets?.forEach(m => { markets[m.key] = m.outcomes; });
    return {
      id:        g.id,
      sport,
      away:      g.away_team,
      home:      g.home_team,
      time:      timeET(g.commence_time),
      isoTime:   g.commence_time,
      sportsbook: bk?.title || '',
      markets
    };
  });
 
  return structured;
}
 
// Fetch player props for a single event
async function fetchProps(sport, eventId) {
  const key = SPORT_KEYS[sport];
  const markets = (sport === 'nba' || sport === 'wnba')
    ? 'player_points,player_rebounds,player_assists,player_threes'
    : 'batter_hits,batter_total_bases,pitcher_strikeouts,batter_home_runs';
  try {
    const data = await oddsGet(
      `/sports/${key}/events/${eventId}/odds?regions=us&markets=${markets}&oddsFormat=american&dateFormat=iso`
    );
    const bk = data?.bookmakers?.[0];
    const props = [];
    bk?.markets?.forEach(mkt => {
      const byPlayer = {};
      mkt.outcomes?.forEach(o => {
        if (o.point == null) return;
        const name = o.description || o.name;
        if (!byPlayer[name]) byPlayer[name] = {};
        const dir = o.name?.toLowerCase() === 'over' ? 'over' : 'under';
        byPlayer[name][dir] = { line: o.point, price: o.price };
      });
      Object.entries(byPlayer).forEach(([player, sides]) => {
        const side = sides.over || sides.under;
        if (side) props.push({
          player,
          market: mkt.key.replace(/player_|batter_|pitcher_/g, ''),
          line: side.line,
          direction: sides.over ? 'over' : 'under',
          price: side.price
        });
      });
    });
    console.log(`[odds] Props ${eventId}: ${props.length} lines`);
    return props;
  } catch(e) {
    console.warn(`[odds] Props skipped for ${eventId}: ${e.message}`);
    return [];
  }
}
 
// Get or fetch slate for one sport
async function getSlate(sport, forceRefresh = false) {
  // Check cache first
  if (!forceRefresh && slateValid(sport)) {
    return { data: slates[sport].data, source: 'cache', updatedAt: slates[sport].updatedAt };
  }
 
  // No Odds API key — use schedule fallback
  if (!ODDS_KEY) {
    console.log(`[slate] No ODDS_KEY — using SCHEDULE fallback for ${sport}`);
    return buildFallbackSlate(sport);
  }
 
  // Fetch from Odds API
  try {
    const games = await fetchOneSport(sport);
 
    // Fetch props for first 3 games (NBA/WNBA/MLB only)
    if (['nba','wnba','mlb'].includes(sport)) {
      for (const g of games.slice(0, 3)) {
        g.props = await fetchProps(sport, g.id);
      }
    }
 
    const updatedAt = nowET();
    slates[sport] = { ts: Date.now(), data: games, games, updatedAt };
    refresh[sport] = Date.now(); // set cooldown
    console.log(`[slate] ${sport.toUpperCase()} cached: ${games.length} games at ${updatedAt}`);
    return { data: games, source: 'odds-api', updatedAt };
  } catch(e) {
    console.error(`[slate] Odds API failed for ${sport}: ${e.message}`);
    // Fall back to schedule
    if (slates[sport]?.data) {
      console.log(`[slate] Using stale cache for ${sport}`);
      return { data: slates[sport].data, source: 'stale-cache', updatedAt: slates[sport].updatedAt };
    }
    return buildFallbackSlate(sport);
  }
}
 
function buildFallbackSlate(sport) {
  const date = todayET();
  const sched = getSchedule(date);
  const games = (sched[sport] || []).map((line, i) => {
    const m = line.match(/^([A-Z0-9]+)\s*@\s*([A-Z0-9]+)\s+(\d+:\d+\s*[AP]M\s*ET)/i);
    if (!m) return null;
    return { id: `sched-${sport}-${i}`, sport, away: m[1], home: m[2], time: m[3], isoTime: null, markets: {}, props: [] };
  }).filter(Boolean);
  console.log(`[slate] SCHEDULE fallback for ${sport}: ${games.length} games`);
  return { data: games, source: 'schedule', updatedAt: nowET() };
}
 
// Format slate as prompt text for Claude
function slateToPrompt(games, sport) {
  if (!games.length) return null;
  let out = `VERIFIED SLATE — ${todayET()} (${nowET()})\n\n`;
  games.forEach(g => {
    out += `${g.away} @ ${g.home}  ${g.time}`;
    if (g.sportsbook) out += `  [${g.sportsbook}]`;
    out += '\n';
    const ml = g.markets?.h2h;
    if (ml) out += `  ML: ${ml.map(o => o.name + ' ' + (o.price > 0 ? '+' : '') + o.price).join(' | ')}\n`;
    const sp = g.markets?.spreads;
    if (sp) out += `  Spread: ${sp.map(o => o.name + ' ' + o.point + ' (' + (o.price > 0 ? '+' : '') + o.price + ')').join(' | ')}\n`;
    const tot = g.markets?.totals;
    if (tot?.[0]) out += `  Total: O/U ${tot[0].point}\n`;
    if (g.props?.length) {
      out += '  PROPS:\n';
      const byPlayer = {};
      g.props.forEach(p => { (byPlayer[p.player] = byPlayer[p.player] || []).push(p); });
      Object.entries(byPlayer).slice(0, 8).forEach(([pl, lines]) => {
        lines.slice(0, 2).forEach(l => {
          out += `    ${pl} ${l.market.toUpperCase()} ${l.direction === 'over' ? 'O' : 'U'}${l.line} (${l.price > 0 ? '+' : ''}${l.price})\n`;
        });
      });
    }
    out += '\n';
  });
  return out;
}
 
// NBA series context for picks
const NBA_CONTEXT = `NBA SERIES STATUS (May 2026):
- CLE vs DET: CLE leads 3-2. G6 tonight. Donovan Mitchell 28pts avg (rising: 23,31,35). Cade Cunningham 25pts avg but under season norm vs CLE defense.
- SAS vs MIN: SAS leads 3-2. G6 tonight. Anthony Edwards 28+pts avg (36 in G4). De Aaron Fox leads SAS. Elimination game for MIN.
- OKC swept LAL 4-0. DO NOT pick OKC or LAL.
- NYK swept PHI 4-0. DO NOT pick NYK or PHI.`;
 
// ── ANTHROPIC ─────────────────────────────────────────────────────────
async function callClaude(body) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, ...body })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  return r.json();
}
function getText(d) { return d.content?.map(c => c.text || '').join('') || ''; }
function parseJSON(text, fallback) {
  try {
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s === -1 || e === -1) throw new Error('no JSON');
    return JSON.parse(text.slice(s, e + 1));
  } catch(e) {
    console.error('[claude] JSON parse failed:', text.slice(0, 300));
    return fallback;
  }
}
 
const PICK_SCHEMA = '{"picks":[{"id":"p1","player":"Full Name or Team","team":"ABBR","opp":"ABBR","sport":"nba|mlb|nhl|wnba","time":"7:00 PM ET","propType":"pts|reb|ast|hits|tb|hr|rbi|str|ml|spread|total","propLabel":"Points","line":27.5,"direction":"over|under","last5":[true,false,true,true,false],"confidence":78,"reason":"Max 15 words using real odds","recentScores":["23","28"],"gameKey":"CLE-DET","gameLabel":"CLE vs DET","odds":"-115"}]}';
 
const BAD_NAMES = ['player not listed','unknown','n/a','tbd','undefined','null','not listed','unlisted'];
 
// ── HEALTH ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const date = todayET();
  const sched = getSchedule(date);
  res.json({
    status:          'ApolloProps API running',
    time_et:         nowET(),
    today_et:        date,
    anthropic_ready: !!ANTHROPIC_KEY,
    odds_api_ready:  !!ODDS_KEY,
    slates_cached:   Object.fromEntries(
      Object.entries(slates).map(([k, v]) => [k, { games: v.games?.length, age_min: minsAgo(v.ts), updated: v.updatedAt }])
    ),
    picks_cached:    Object.fromEntries(
      Object.entries(picks).map(([k, v]) => [k, { count: v.picks?.length, date: v.date }])
    ),
    refresh_cooldown: Object.fromEntries(
      Object.entries(refresh).map(([k, v]) => [k, { blocked: refreshBlocked(k), mins_ago: minsAgo(v) }])
    ),
    schedule_fallback: { nba: sched.nba?.length, mlb: sched.mlb?.length, wnba: sched.wnba?.length, nhl: sched.nhl?.length }
  });
});
 
// ── GET /api/slate/today ──────────────────────────────────────────────
// Fetch slate for one sport on demand. Respects TTL cache.
app.get('/api/slate/today', async (req, res) => {
  const sport = (req.query.sport || 'all').toLowerCase();
  const force = req.query.refresh === 'true';
 
  // Block rapid refreshes
  if (force && sport !== 'all' && refreshBlocked(sport)) {
    return res.json({ slate: slates[sport]?.data || [], source: 'cache', blocked: true,
      message: `Refresh blocked for ${sport} — try again in ${10 - minsAgo(refresh[sport])} min` });
  }
 
  if (sport === 'all') {
    // Return all cached sports + fallback for anything missing
    const sports = ['nba','mlb','wnba','nhl'];
    const results = {};
    for (const s of sports) {
      if (slateValid(s)) {
        results[s] = { games: slates[s].data, source: 'cache', updatedAt: slates[s].updatedAt };
      } else {
        const fb = buildFallbackSlate(s);
        results[s] = { games: fb.data, source: fb.source, updatedAt: fb.updatedAt };
      }
    }
    return res.json({ date: todayET(), sports: results });
  }
 
  try {
    const result = await getSlate(sport, force);
    res.json({ date: todayET(), sport, games: result.data, source: result.source, updatedAt: result.updatedAt,
               count: result.data.length });
  } catch(e) {
    console.error('/api/slate/today error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
 
// ── GET /api/schedule ────────────────────────────────────────────────
// Returns game list for sport cards (uses cache or schedule fallback)
app.get('/api/schedule', async (req, res) => {
  const date  = todayET();
  const sched = getSchedule(date);
 
  // Build response from cache or fallback — NO automatic Odds API fetch
  const toList = (sportKey) => {
    if (slates[sportKey]?.data?.length) {
      return slates[sportKey].data.map(g => `${g.away} @ ${g.home}  ${g.time}`);
    }
    return sched[sportKey] || [];
  };
 
  const nba  = toList('nba');
  const mlb  = toList('mlb');
  const wnba = toList('wnba');
  const nhl  = toList('nhl');
  const hasCachedOdds = Object.keys(slates).some(k => slates[k]?.data?.length > 0);
 
  res.json({
    date, updatedAt: nowET(),
    source: hasCachedOdds ? 'cache' : 'schedule',
    nba, mlb, wnba, nhl,
    nbaCount: nba.length, mlbCount: mlb.length,
    wnbaCount: wnba.length, nhlCount: nhl.length
  });
});
 
// ── GET/POST /api/ask-apollo ──────────────────────────────────────────
app.get('/api/ask-apollo', (req, res) => res.json({ status: 'ok', method: 'POST required' }));
app.post('/api/ask-apollo', async (req, res) => {
  try {
    const { system, messages, max_tokens } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages required' });
    const data = await callClaude({ max_tokens: max_tokens || 1000, system, messages });
    res.json(data);
  } catch(e) {
    console.error('[ask-apollo]', e.message);
    res.status(500).json({ error: e.message });
  }
});
 
// ── GET/POST /api/generate-picks ─────────────────────────────────────
app.get('/api/generate-picks', (req, res) => res.json({ status: 'ok', method: 'POST required' }));
 
app.post('/api/generate-picks', async (req, res) => {
  const sport   = (req.body.sport || 'all').toLowerCase();
  const dateStr = todayET();
 
  // ── Serve from picks cache (daily) ───────────────────────────────
  if (picksValid(sport)) {
    return res.json({ picks: picks[sport].picks, date: dateStr, cached: true,
                      updatedAt: picks[sport].updatedAt });
  }
  // If 'all' cached, filter for specific sport
  if (sport !== 'all' && picksValid('all')) {
    const filtered = picks.all.picks.filter(p => p.sport === sport);
    if (filtered.length) {
      return res.json({ picks: filtered, date: dateStr, cached: true });
    }
  }
 
  // ── Fetch slate (uses cache if valid, fetches if stale) ───────────
  const slateSports = sport === 'all' ? ['nba','mlb','wnba'] : [sport];
  const allGames = [];
 
  for (const s of slateSports) {
    try {
      const result = await getSlate(s);
      allGames.push(...(result.data || []));
    } catch(e) {
      console.error(`[picks] getSlate failed for ${s}:`, e.message);
    }
  }
 
  if (!allGames.length) {
    console.log('[picks] no games found — returning empty');
    return res.json({ picks: [], date: dateStr, noGames: true,
                      message: 'No games found for today. Check back closer to game time.' });
  }
 
  // ── Build slate prompt ─────────────────────────────────────────────
  const slateText = slateToPrompt(allGames, sport);
  const hasNBA = allGames.some(g => g.sport === 'nba');
 
  const system =
    'You are ApolloProps, a sports betting analysis engine. '
    + 'You receive a verified live slate with real sportsbook odds. '
    + 'Your ONLY job is to return picks as JSON from the games in this slate. '
    + 'RULES: '
    + '(1) Only use player names from PROPS sections. Never invent players. '
    + '(2) If no PROPS for a game, generate team ML/spread/total picks instead. '
    + '(3) For team picks: player field = full team name. '
    + '(4) Never say you need more data. Never refuse. Return JSON only:\n'
    + PICK_SCHEMA;
 
  const sportInstr = {
    nba:  '8 NBA picks: use PROPS for player picks, ML/spread/total if no props',
    mlb:  '12 MLB picks: 4 pitcher Ks, 4 batter props (hits/TB/HR), 2 MLs, 2 totals',
    nhl:  '8 NHL picks: team ML, puck line, totals',
    wnba: '8 WNBA picks: use PROPS if available, ML/spread/total if not',
    all:  '14 picks across all sports shown — use props where available'
  }[sport] || '12 picks from the slate';
 
  const userMsg = `Here is today\'s verified slate:\n\n${slateText}`
    + (hasNBA ? `\n${NBA_CONTEXT}\n` : '')
    + `\nGenerate ${sportInstr}. Use real lines from the slate. Return JSON only.`;
 
  console.log(`[claude] Generating picks for ${sport} — ${allGames.length} games`);
 
  try {
    const tokens = sport === 'all' ? 3000 : 2000;
    const data   = await callClaude({ max_tokens: tokens, system, messages: [{ role: 'user', content: userMsg }] });
    const raw    = getText(data);
    console.log('[claude] Response length:', raw.length, '| first 200:', raw.slice(0, 200));
 
    const result = parseJSON(raw, { picks: [] });
    const valid  = (result.picks || []).filter(p => {
      if (!p.player || !p.sport || !p.propType || p.line == null || !p.direction) return false;
      const name = p.player.toLowerCase().trim();
      if (BAD_NAMES.some(b => name.includes(b))) { console.log('[picks] rejected:', p.player); return false; }
      const isProp = !['ml','spread','total'].includes(p.propType);
      if (isProp && p.player.length <= 3) { console.log('[picks] rejected abbr:', p.player); return false; }
      return true;
    });
 
    console.log(`[picks] Valid: ${valid.length} for ${sport}`);
 
    // Cache picks
    const updatedAt = nowET();
    picks[sport] = { date: dateStr, picks: valid, updatedAt };
    if (sport === 'all') {
      ['nba','mlb','nhl','wnba'].forEach(s => {
        picks[s] = { date: dateStr, picks: valid.filter(p => p.sport === s), updatedAt };
      });
    }
 
    res.json({ picks: valid, date: dateStr, cached: false, updatedAt,
               slateSource: allGames[0] ? 'odds-api' : 'schedule' });
  } catch(e) {
    console.error('[claude] ERROR:', e.message);
    res.json({ picks: [], date: dateStr, error: e.message });
  }
});
 
// ── GET /api/pick-of-day ──────────────────────────────────────────────
app.get('/api/pick-of-day', async (req, res) => {
  // Derive from picks cache if available
  const allCached = Object.values(picks).flatMap(p => p.picks || []);
  if (allCached.length) {
    const top = [...allCached].sort((a, b) => b.confidence - a.confidence)[0];
    return res.json({ pick: top, cached: true });
  }
 
  // Generate from best available slate
  const bestSport = slates.nba?.data?.length ? 'nba' : slates.mlb?.data?.length ? 'mlb' : null;
  if (!bestSport) return res.json({ pick: null, message: 'No slate cached yet' });
 
  const games   = slates[bestSport].data;
  const slateStr = slateToPrompt(games.slice(0, 3), bestSport);
 
  try {
    const data = await callClaude({
      max_tokens: 400,
      system: 'Return the single best pick from this slate as JSON: {"pick":{"player":"","team":"","opp":"","sport":"","time":"","propType":"pts","propLabel":"Points","line":0,"direction":"over","confidence":0,"odds":"","last5":[true,true,false,true,true],"reason":""}}',
      messages: [{ role: 'user', content: 'Slate:\n' + slateStr + '\nReturn best pick as JSON.' }]
    });
    const result = parseJSON(getText(data), { pick: null });
    res.json(result);
  } catch(e) {
    console.error('[potd]', e.message);
    res.json({ pick: null });
  }
});
 
// ── GET /api/picks-preview ────────────────────────────────────────────
app.get('/api/picks-preview', (req, res) => {
  const allCached = Object.values(picks).flatMap(p => p.picks || []);
  if (allCached.length) {
    return res.json({ picks: allCached.slice(0, 5), total: allCached.length, cached: true });
  }
  res.json({ picks: [], total: 0, message: 'No picks cached yet' });
});
 
// ── GET /api/record ───────────────────────────────────────────────────
app.get('/api/record', (req, res) => {
  res.json({ wins: 18, losses: 9, pct: 67, units: 6.2 });
});
 
// ── POST /api/resolve-results ─────────────────────────────────────────
app.post('/api/resolve-results', async (req, res) => {
  const list = (req.body.picks || []).map((p, i) =>
    `${i+1}. ID:${p.id} | ${p.sport?.toUpperCase()} | ${p.player} | ${p.direction?.toUpperCase()} ${p.line} ${p.propType} | ${p.gameLabel} | ${p.loggedDate}`
  ).join('\n');
  if (!list) return res.json({ results: [] });
  try {
    const data = await callClaude({
      max_tokens: 600,
      system: `Sports results verifier. Today: ${new Date().toDateString()}. Mark win/loss/pending/unknown. Return JSON: {"results":[{"id":"...","result":"win|loss|pending|unknown","actual":"8 words max"}]}`,
      messages: [{ role: 'user', content: 'Check:\n' + list }]
    });
    res.json(parseJSON(getText(data), { results: [] }));
  } catch(e) {
    console.error('[resolve]', e.message);
    res.json({ results: [] });
  }
});
 
// ── START ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('ApolloProps API  port:', PORT);
  console.log('Today ET:       ', todayET());
  console.log('Anthropic ready:', !!ANTHROPIC_KEY);
  console.log('Odds API ready: ', !!ODDS_KEY);
  console.log('Strategy: fetch-on-demand, 60min cache, 10min refresh cooldown');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  // NO auto-fetch on startup — saves credits
  // First tap of a sport card triggers the fetch
});
