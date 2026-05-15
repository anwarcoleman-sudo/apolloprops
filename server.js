/*
 * ApolloProps API Server
 * ======================
 * Architecture:
 *   1. Odds API  → fetches today's real games + lines (cached 5 min)
 *   2. Claude    → receives structured slate, returns picks JSON
 *   3. Frontend  → displays picks with timestamp
 *
 * If Odds API fails  → show "Live odds temporarily unavailable"
 * Claude NEVER sees a blank slate → NEVER refuses
 *
 * Railway env vars:
 *   ANTHROPIC_API_KEY = sk-ant-...
 *   ODDS_API_KEY      = your-odds-api-key
 */
 
const express = require('express');
const cors    = require('cors');
const app     = express();
app.use(express.json());
 
// ── CORS ──────────────────────────────────────────────────────────────────
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
 
// ── CONFIG ─────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ODDS_KEY      = process.env.ODDS_API_KEY;
const MODEL         = 'claude-sonnet-4-20250514';
const ODDS_BASE     = 'https://api.the-odds-api.com/v4';
 
// ── TIME HELPERS ──────────────────────────────────────────────────────────
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
    timeZone: 'America/New_York',
    hour: 'numeric', minute: '2-digit', hour12: true
  }) + ' ET';
}
function isToday(iso) {
  const gameDate = new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const today    = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  return gameDate === today;
}
 
// ── CACHE ─────────────────────────────────────────────────────────────────
// Slate cache: 5 minutes (reduces Odds API credit usage)
// Picks cache: rest of day (reset at midnight ET)
const slateCache = { data: null, sport: null, ts: 0 };          // 5-min TTL
const picksCache = { picks: {}, date: null };                    // daily TTL
const potdCache  = { pick: null, date: null };
 
const SLATE_TTL = 5 * 60 * 1000; // 5 minutes
 
function slateIsValid(sport) {
  if (!slateCache.data) return false;
  if ((Date.now() - slateCache.ts) >= SLATE_TTL) return false;
  // 'all' cache satisfies any sport request
  if (slateCache.sport === 'all') return true;
  return slateCache.sport === sport;
}
function picksAreValid(sport) {
  return picksCache.date === todayET() && picksCache.picks[sport]?.length;
}
function potdIsValid() {
  return potdCache.date === todayET() && potdCache.pick;
}
 
// Reset picks at midnight ET
function clearAtMidnight() {
  const etNow  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etNext = new Date(etNow); etNext.setHours(24, 0, 0, 0);
  const ms     = etNext - etNow;
  setTimeout(() => {
    picksCache.picks = {}; picksCache.date = null;
    potdCache.pick   = null; potdCache.date  = null;
    console.log('[cache] Picks cache cleared at midnight ET');
    clearAtMidnight();
  }, ms);
  console.log('[cache] Next clear in', Math.round(ms / 60000), 'minutes');
}
clearAtMidnight();
 
// ── ODDS API ──────────────────────────────────────────────────────────────
async function oddsGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = ODDS_BASE + path + sep + 'apiKey=' + ODDS_KEY;
  const r   = await fetch(url);
  const rem = r.headers.get('x-requests-remaining');
  console.log('[odds] GET', path.split('?')[0], '→', r.status, rem ? '| remaining: ' + rem : '');
  if (!r.ok) throw new Error('Odds API ' + r.status + ': ' + await r.text());
  return r.json();
}
 
// Fetch today's games + main markets for one sport key
async function fetchGames(sportKey) {
  const games = await oddsGet(
    '/sports/' + sportKey + '/odds/'
    + '?regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso'
  );
  // Filter: games starting within next 36 hours (catches today + tonight in any timezone)
  const now = Date.now();
  const window = 36 * 60 * 60 * 1000;
  const relevant = (games || []).filter(g => {
    const t = new Date(g.commence_time).getTime();
    return t >= now - 3 * 60 * 60 * 1000 && t <= now + window; // started up to 3hrs ago or upcoming 36hrs
  });
  console.log('[odds]', sportKey, '→', games.length, 'total,', relevant.length, 'in window');
  return relevant;
}
 
// Fetch player props for one event (NBA + MLB top games only)
async function fetchProps(sportKey, eventId, eventLabel) {
  const markets = (sportKey === 'basketball_nba' || sportKey === 'basketball_wnba')
    ? 'player_points,player_rebounds,player_assists,player_threes'
    : 'batter_hits,batter_total_bases,pitcher_strikeouts,batter_home_runs';
  try {
    const data = await oddsGet(
      '/sports/' + sportKey + '/events/' + eventId + '/odds'
      + '?regions=us&markets=' + markets + '&oddsFormat=american&dateFormat=iso'
    );
    const bk     = data?.bookmakers?.[0];
    const props  = [];
    bk?.markets?.forEach(mkt => {
      mkt.outcomes?.forEach(o => {
        if (o.point != null) {
          props.push({
            player:    o.name,
            market:    mkt.key.replace('player_','').replace('batter_','').replace('pitcher_',''),
            line:      o.point,
            direction: mkt.outcomes.indexOf(o) % 2 === 0 ? 'over' : 'under',
            price:     o.price
          });
        }
      });
    });
    console.log('[odds] props', eventLabel, '→', props.length, 'lines');
    return props;
  } catch(e) {
    console.warn('[odds] props fetch skipped for', eventLabel, ':', e.message);
    return [];
  }
}
 
// Build full structured slate for one or all sports
async function buildSlate(sportFilter) {
  const sportMap = { nba: 'basketball_nba', mlb: 'baseball_mlb', nhl: 'icehockey_nhl', wnba: 'basketball_wnba' };
  // Include wnba in 'all' fetch during WNBA season (May-Sept)
  const month = new Date().getMonth(); // 0=Jan, 4=May, 8=Sept
  const wnbaInSeason = month >= 4 && month <= 8;
  const allSports = wnbaInSeason
    ? Object.entries(sportMap)
    : Object.entries(sportMap).filter(([k]) => k !== 'wnba');
  const sports   = sportFilter === 'all'
    ? allSports
    : [[sportFilter, sportMap[sportFilter]]].filter(([,v]) => v);
 
  const result = { date: todayET(), updatedAt: nowET(), games: [] };
 
  for (const [sport, key] of sports) {
    const games = await fetchGames(key);
    let propsCount = 0;
 
    for (const g of games) {
      const gameObj = {
        id:      g.id,
        sport,
        away:    g.away_team,
        home:    g.home_team,
        time:    timeET(g.commence_time),
        markets: {}
      };
 
      // Extract best odds from first bookmaker
      const bk = g.bookmakers?.[0];
      if (bk) {
        gameObj.sportsbook = bk.title;
        bk.markets?.forEach(mkt => {
          gameObj.markets[mkt.key] = mkt.outcomes.map(o => ({
            name:  o.name,
            price: o.price,
            point: o.point
          }));
        });
      }
 
      // Fetch player props for first 3 games per sport
      if (propsCount < 3 && (sport === 'nba' || sport === 'mlb' || sport === 'wnba')) {
        gameObj.props = await fetchProps(key, g.id, g.away_team + ' @ ' + g.home_team);
        propsCount++;
      } else {
        gameObj.props = [];
      }
 
      result.games.push(gameObj);
    }
  }
 
  console.log('[slate] Built:', result.games.length, 'total games');
  return result;
}
 
// Format slate as structured text for Claude prompt
function slateToPrompt(slate, sport) {
  const games = slate.games.filter(g => sport === 'all' || g.sport === sport);
  if (!games.length) return null;
 
  let out = 'VERIFIED LIVE SLATE — ' + slate.date + ' (updated ' + slate.updatedAt + ')\n';
  out    += 'Source: The Odds API | Timezone: America/New_York\n\n';
 
  const bySport = {};
  games.forEach(g => { (bySport[g.sport] = bySport[g.sport] || []).push(g); });
 
  Object.entries(bySport).forEach(([sp, gs]) => {
    out += '═══ ' + sp.toUpperCase() + ' ═══\n';
    gs.forEach(g => {
      out += g.away + ' @ ' + g.home + '  ' + g.time;
      if (g.sportsbook) out += '  [' + g.sportsbook + ']';
      out += '\n';
 
      const ml = g.markets.h2h;
      if (ml) out += '  ML:     ' + ml.map(o => o.name + ' ' + (o.price > 0 ? '+' : '') + o.price).join(' | ') + '\n';
 
      const sp2 = g.markets.spreads;
      if (sp2) out += '  Spread: ' + sp2.map(o => o.name + ' ' + o.point + ' (' + (o.price > 0 ? '+' : '') + o.price + ')').join(' | ') + '\n';
 
      const tot = g.markets.totals;
      if (tot) out += '  Total:  O/U ' + tot[0]?.point + '\n';
 
      if (g.props.length) {
        out += '  PROPS:\n';
        // Group by player
        const byPlayer = {};
        g.props.forEach(p => { (byPlayer[p.player] = byPlayer[p.player] || []).push(p); });
        Object.entries(byPlayer).slice(0, 6).forEach(([player, lines]) => {
          lines.forEach(l => {
            out += '    ' + player + ' ' + l.market.toUpperCase()
              + ' ' + (l.direction === 'over' ? 'O' : 'U') + l.line
              + ' (' + (l.price > 0 ? '+' : '') + l.price + ')\n';
          });
        });
      }
      out += '\n';
    });
  });
 
  return out;
}
 
// ── ANTHROPIC ─────────────────────────────────────────────────────────────
function parseJSON(text, fallback) {
  try {
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s === -1 || e === -1) throw new Error('no JSON');
    return JSON.parse(text.slice(s, e + 1));
  } catch(err) {
    console.error('[claude] JSON parse failed:', err.message);
    console.error('[claude] raw (first 400):', text.slice(0, 400));
    return fallback;
  }
}
 
async function callClaude(body) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: MODEL, ...body })
  });
  if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + await r.text());
  return r.json();
}
 
function getText(d) { return d.content?.map(c => c.text || '').join('') || ''; }
 
// ── PICK SCHEMA ───────────────────────────────────────────────────────────
const PICK_SCHEMA = '{"picks":['
  + '{"id":"p1",'
  // PLAYER PROPS: player = real player full name e.g. "LeBron James", "Shohei Ohtani"
  // TEAM PICKS:  player = team name e.g. "Los Angeles Lakers", "New York Yankees"
  + '"player":"REQUIRED — real player full name for props, team name for ML/spread/total",'
  + '"team":"ABBR","opp":"ABBR",'
  + '"sport":"nba|mlb|nhl|wnba",'
  + '"time":"7:00 PM ET",'
  + '"propType":"pts|reb|ast|hits|tb|hr|rbi|str|ml|spread|total",'
  + '"propLabel":"Points",'
  + '"line":27.5,'
  + '"direction":"over|under",'
  + '"last5":[true,false,true,true,false],'
  + '"confidence":78,'
  + '"reason":"Max 15 words using the actual odds shown",'
  + '"recentScores":["23","28","31"],'
  + '"gameKey":"CLE-DET",'
  + '"gameLabel":"CLE vs DET",'
  + '"odds":"-115"}'
  + ']}';
 
// ── HEALTH ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const fallback = getSchedule(todayET());
  res.json({
    status:           'ApolloProps API running',
    time_et:          nowET(),
    today_et:         todayET(),
    anthropic_ready:  !!ANTHROPIC_KEY,
    odds_api_ready:   !!ODDS_KEY,
    slate_cached:     slateIsValid('all'),
    slate_games:      slateCache.data?.games?.length || 0,
    slate_age_sec:    slateCache.ts ? Math.round((Date.now() - slateCache.ts) / 1000) : null,
    picks_cached:     Object.fromEntries(Object.entries(picksCache.picks).map(([k,v])=>[k,v?.length||0])),
    schedule_fallback: {
      nba: fallback.nba?.length || 0,
      mlb: fallback.mlb?.length || 0,
      wnba: fallback.wnba?.length || 0,
      nhl: fallback.nhl?.length || 0
    }
  });
});
 
// ── GET /api/slate/today ──────────────────────────────────────────────────
app.get('/api/slate/today', async (req, res) => {
  const sport = req.query.sport || 'all';
  if (slateIsValid(sport)) {
    return res.json({ slate: slateCache.data, cached: true, ageSeconds: Math.round((Date.now()-slateCache.ts)/1000) });
  }
  if (!ODDS_KEY) return res.json({ slate: null, error: 'ODDS_API_KEY not set in Railway Variables' });
  try {
    const slate = await buildSlate(sport);
    slateCache.data = slate; slateCache.sport = 'all'; slateCache.ts = Date.now(); // always cache as 'all'
    res.json({ slate, cached: false });
  } catch(e) {
    console.error('[slate] fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
 
// ── GET /api/schedule ─────────────────────────────────────────────────────
app.get('/api/schedule', async (req, res) => {
  const date = todayET();
 
  // Try live Odds API first
  let slate = slateIsValid('all') ? slateCache.data : null;
  if (!slate && ODDS_KEY) {
    try {
      slate = await buildSlate('all');
      slateCache.data = slate; slateCache.sport = 'all'; slateCache.ts = Date.now();
      console.log('[schedule] Live slate loaded:', slate.games.length, 'games');
    } catch(e) { console.error('[schedule] Odds API error:', e.message); }
  }
 
  // Build game lists from live slate
  let nba  = (slate?.games||[]).filter(g=>g.sport==='nba').map(g=>g.away+' @ '+g.home+'  '+g.time);
  let mlb  = (slate?.games||[]).filter(g=>g.sport==='mlb').map(g=>g.away+' @ '+g.home+'  '+g.time);
  let nhl  = (slate?.games||[]).filter(g=>g.sport==='nhl').map(g=>g.away+' @ '+g.home+'  '+g.time);
  let wnba = (slate?.games||[]).filter(g=>g.sport==='wnba').map(g=>g.away+' @ '+g.home+'  '+g.time);
  let source = slate ? 'odds-api' : null;
 
  // FALLBACK: if Odds API returned nothing, use our SCHEDULE object
  if (!nba.length && !mlb.length) {
    const fallback = getSchedule(date);
    if (fallback.nba.length || fallback.mlb.length) {
      nba  = fallback.nba  || [];
      mlb  = fallback.mlb  || [];
      nhl  = fallback.nhl  || [];
      wnba = fallback.wnba || [];
      source = 'schedule-object';
      console.log('[schedule] Using SCHEDULE fallback for', date);
    }
  }
 
  console.log('[schedule]', date, '| NBA:', nba.length, '| MLB:', mlb.length, '| source:', source||'none');
 
  res.json({
    date,
    updatedAt: slate?.updatedAt || new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',hour12:true})+' ET',
    source,
    nba,  mlb,  nhl,  wnba,
    nbaCount: nba.length, mlbCount: mlb.length,
    nhlCount: nhl.length, wnbaCount: wnba.length
  });
});
 
// ── GET/POST /api/ask-apollo ──────────────────────────────────────────────
app.get('/api/ask-apollo', (req, res) => res.json({ status: 'ok', method: 'POST required' }));
app.post('/api/ask-apollo', async (req, res) => {
  try {
    const { system, messages, max_tokens } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages required' });
    const data = await callClaude({ max_tokens: max_tokens||1000, system, messages });
    res.json(data);
  } catch(e) {
    console.error('[ask-apollo]', e.message);
    res.status(500).json({ error: e.message });
  }
});
 
// ── GET/POST /api/generate-picks ──────────────────────────────────────────
app.get('/api/generate-picks', (req, res) => res.json({ status: 'ok', method: 'POST required' }));
 
app.post('/api/generate-picks', async (req, res) => {
  const sport   = req.body.sport || 'all';
  const dateStr = todayET();
 
  // ── Serve from picks cache ────────────────────────────────────────────
  if (picksAreValid(sport)) {
    console.log('[picks] serving cache:', sport, picksCache.picks[sport].length, 'picks');
    return res.json({ picks: picksCache.picks[sport], date: dateStr, cached: true, slateTime: slateCache.data?.updatedAt });
  }
  if (picksAreValid('all') && sport !== 'all') {
    const f = picksCache.picks.all.filter(p => p.sport === sport);
    if (f.length) return res.json({ picks: f, date: dateStr, cached: true });
  }
 
  // ── STEP 1: Fetch live slate ──────────────────────────────────────────
  console.log('[picks] generating fresh picks — sport:', sport);
 
  if (!ODDS_KEY) {
    console.error('[picks] ODDS_API_KEY not set — cannot fetch verified slate');
    return res.json({
      picks: [], date: dateStr, oddsError: true,
      message: 'Live odds temporarily unavailable. Add ODDS_API_KEY to Railway Variables.'
    });
  }
 
  let slate = slateIsValid(sport) || slateIsValid('all') ? slateCache.data : null;
  if (!slate) {
    try {
      console.log('[odds] fetching live slate for', sport);
      slate = await buildSlate(sport === 'all' ? 'all' : sport);
      // Always cache as 'all' if we fetched multiple sports
      // This prevents a single-sport request from poisoning the cache
      slateCache.data  = slate;
      slateCache.sport = 'all';
      slateCache.ts    = Date.now();
      console.log('[odds] slate fetched:', slate.games.length, 'games');
    } catch(e) {
      console.error('[odds] FETCH FAILED:', e.message);
      return res.json({
        picks: [], date: dateStr, oddsError: true,
        message: 'Live odds temporarily unavailable. Please try again in a moment.'
      });
    }
  }
 
  // ── STEP 2: Check if games exist ─────────────────────────────────────
  const relevantGames = slate.games.filter(g => sport === 'all' || g.sport === sport);
  if (!relevantGames.length) {
    console.log('[picks] no games found for', sport, 'on', dateStr);
    return res.json({
      picks: [], date: dateStr, noGames: true,
      slateTime: slate.updatedAt,
      message: 'No ' + sport.toUpperCase() + ' games found for today.'
    });
  }
 
  // ── STEP 3: Format slate and send to Claude ───────────────────────────
  const slatePrompt = slateToPrompt({ ...slate, games: relevantGames }, sport);
 
  const system =
    'You are ApolloProps, a sports betting data engine. '
    + 'You will receive a verified live slate with real sportsbook odds. '
    + 'Some games include PROPS (player lines). Others have only team markets (ML/spread/total). '
    + '\n\nRULES — READ CAREFULLY:\n'
    + '1. ONLY use player names explicitly listed in the PROPS section of the slate. '
    +    'If a game has no PROPS section, do NOT generate player prop picks for that game. '
    +    'Generate team picks (ML/spread/total) instead using the team markets shown.\n'
    + '2. NEVER invent player names. NEVER use "player not listed", "unknown", or placeholder names.\n'
    + '3. For PROP picks: player field = exact player name from PROPS e.g. "Luka Doncic", "Caitlin Clark".\n'
    + '4. For TEAM picks (ml/spread/total): player field = full team name e.g. "Dallas Mavericks".\n'
    + '5. Only use games, teams, and players shown in the slate. No invented matchups.\n'
    + '6. Return ONLY valid JSON, no markdown, no explanation:\n'
    + PICK_SCHEMA;
 
  const sportInstr = {
    nba:  'Generate up to 8 NBA picks. For each game: if PROPS are listed use player prop picks (pts/reb/ast). If NO PROPS listed for a game, generate team ML/spread/total picks only. Never invent player names.',
    mlb:  'Generate up to 12 MLB picks. For each game: if PROPS are listed use player props (pitcher Ks, batter hits/TB/HR). If NO PROPS, generate team ML and game total picks only. Never invent player names.',
    nhl:  'Generate up to 8 NHL picks using team ML, puck line, and totals from the slate. Only add player props if PROPS are listed.',
    wnba: 'Generate up to 8 WNBA picks. If PROPS are listed use player names shown. If NO PROPS listed, generate team ML/spread/total picks only using the team names shown. Never invent player names.',
    all:  'Generate up to 16 picks across all sports in the slate. For each game use PROPS section for player picks if available. If no PROPS for a game, use team ML/spread/total only. Never invent player names.'
  }[sport] || 'Generate picks from the slate. Use player names from PROPS sections only. For games without PROPS use team picks.';
 
  const userMsg = 'Here is today\'s verified live slate with real sportsbook odds:\n\n'
    + slatePrompt
    + '\nGenerate ' + sportInstr + '. '
    + 'IMPORTANT: Only use player names explicitly shown in PROPS sections. '
    + 'If a game has no PROPS section, generate team ML/spread/total picks for it instead. '
    + 'Never write player not listed or invent names. Return JSON only.';
 
  console.log('[claude] sending slate:', relevantGames.length, 'games to analyze');
 
  try {
    const maxTok = sport === 'all' ? 4000 : 2000;
    const data  = await callClaude({ max_tokens: maxTok, system, messages: [{ role: 'user', content: userMsg }] });
    const raw   = getText(data);
    console.log('[claude] response length:', raw.length, '| first 300:', raw.slice(0, 300));
 
    const result = parseJSON(raw, { picks: [] });
    // Filter out bad picks — no invented players, no placeholder names
    const BAD_NAMES = ['player not listed','unknown','n/a','tbd','player','undefined',
                       'null','not listed','unlisted','unnamed'];
    const valid  = (result.picks || []).filter(p => {
      if (!p.player || !p.sport || !p.propType || p.line == null || !p.direction) return false;
      const nameLower = p.player.toLowerCase().trim();
      // Reject placeholder names
      if (BAD_NAMES.some(bad => nameLower.includes(bad))) {
        console.log('[picks] rejected bad player name:', p.player);
        return false;
      }
      // Reject if player name looks like a team abbreviation for a prop pick
      const isProp = !['ml','spread','total','h2h','spreads','totals'].includes(p.propType);
      if (isProp && p.player.length <= 3) {
        console.log('[picks] rejected abbreviation as player name:', p.player);
        return false;
      }
      return true;
    });
    console.log('[picks] valid after filter:', valid.length);
 
    // Cache picks
    if (!picksCache.date) picksCache.picks = {};
    picksCache.picks[sport] = valid;
    picksCache.date         = dateStr;
    if (sport === 'all') {
      ['nba','mlb','nhl','wnba'].forEach(s => { picksCache.picks[s] = valid.filter(p => p.sport === s); });
    }
 
    res.json({ picks: valid, date: dateStr, cached: false, slateTime: slate.updatedAt });
  } catch(e) {
    console.error('[claude] ERROR:', e.message);
    res.json({ picks: [], date: dateStr, claudeError: true, message: 'Analysis error: ' + e.message });
  }
});
 
// ── GET /api/pick-of-day ──────────────────────────────────────────────────
app.get('/api/pick-of-day', async (req, res) => {
  if (potdIsValid()) return res.json({ pick: potdCache.pick, cached: true });
 
  // Use best pick from picks cache
  const allPicks = picksCache.picks.all || [];
  if (allPicks.length) {
    const top = [...allPicks].sort((a,b) => b.confidence - a.confidence)[0];
    potdCache.pick = top; potdCache.date = todayET();
    return res.json({ pick: top, cached: true });
  }
 
  // No picks yet — try to generate from slate
  let slate = slateIsValid('all') ? slateCache.data : null;
  if (!slate || !slate.games.length) return res.json({ pick: null, message: 'No slate available yet' });
 
  const slateStr = slateToPrompt(slate, 'all');
  try {
    const data = await callClaude({
      max_tokens: 400,
      system: 'You are ApolloProps. Return the single best pick from this verified slate as JSON: '
            + '{"pick":{"player":"","team":"","opp":"","sport":"nba|mlb","time":"",'
            + '"propType":"pts","propLabel":"Points","line":0,"direction":"over",'
            + '"confidence":0,"odds":"","last5":[true,true,false,true,true],"reason":""}}',
      messages: [{ role: 'user', content: 'Slate:\n' + slateStr + '\nReturn the single best pick.' }]
    });
    const result = parseJSON(getText(data), { pick: null });
    if (result.pick) { potdCache.pick = result.pick; potdCache.date = todayET(); }
    res.json(result);
  } catch(e) {
    console.error('[potd]', e.message);
    res.json({ pick: null });
  }
});
 
// ── GET /api/picks-preview ────────────────────────────────────────────────
app.get('/api/picks-preview', async (req, res) => {
  if (picksAreValid('all')) {
    return res.json({ picks: picksCache.picks.all.slice(0,5), total: picksCache.picks.all.length, cached: true });
  }
  // Return game list as preview
  const slate = slateIsValid('all') ? slateCache.data : null;
  if (slate?.games?.length) {
    const preview = slate.games.slice(0,5).map(g => ({
      player: g.away + ' @ ' + g.home, team: g.away, opp: g.home,
      sport: g.sport, time: g.time, propType: 'ml', propLabel: 'Moneyline',
      line: 0, direction: 'over', confidence: 70, last5: [true,false,true,true,false]
    }));
    return res.json({ picks: preview, total: slate.games.length });
  }
  res.json({ picks: [], total: 0 });
});
 
// ── GET /api/record ───────────────────────────────────────────────────────
// Update these numbers as your real record builds
app.get('/api/record', (req, res) => {
  res.json({ wins: 18, losses: 9, pct: 67, units: 6.2 });
});
 
// ── POST /api/resolve-results ─────────────────────────────────────────────
app.post('/api/resolve-results', async (req, res) => {
  const picks = req.body.picks || [];
  if (!picks.length) return res.json({ results: [] });
  const list = picks.map((p,i) =>
    (i+1)+'. ID:'+p.id+' | '+p.sport.toUpperCase()+' | '+p.player+
    ' | '+p.direction.toUpperCase()+' '+p.line+' '+p.propType+
    ' | '+p.gameLabel+' | '+p.loggedDate
  ).join('\n');
  try {
    const data = await callClaude({
      max_tokens: 600,
      system: 'Sports results verifier. Today: '+new Date().toDateString()+'. '
            + 'Check if picks won or lost. Mark pending if game not yet played. '
            + 'Return JSON only: {"results":[{"id":"...","result":"win|loss|pending|unknown","actual":"8 words"}]}',
      messages: [{ role: 'user', content: 'Check:\n'+list }]
    });
    res.json(parseJSON(getText(data), { results: [] }));
  } catch(e) {
    console.error('[resolve]', e.message);
    res.json({ results: [] });
  }
});
 
// ── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('ApolloProps API running on port', PORT);
  console.log('Today ET:       ', todayET());
  console.log('Anthropic ready:', !!ANTHROPIC_KEY);
  console.log('Odds API ready: ', !!ODDS_KEY);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
 
  // Auto-warm the slate cache on startup so first user gets instant data
  if (ODDS_KEY) {
    setTimeout(async () => {
      try {
        console.log("[startup] Pre-fetching slate for " + todayET());
        const slate = await buildSlate('all');
        if (slate && slate.games.length) {
          slateCache.data  = slate;
          slateCache.sport = 'all';
          slateCache.ts    = Date.now();
          console.log('[startup] Slate cached:', slate.games.length, 'games');
          slate.games.forEach(g => console.log('[startup]', g.sport.toUpperCase(), g.away, '@', g.home, g.time));
        } else {
          console.log('[startup] No games found from Odds API — using SCHEDULE fallback');
        }
      } catch(e) {
        console.error('[startup] Slate pre-fetch failed:', e.message);
      }
    }, 2000); // 2 second delay after server starts
  }
});const SCHEDULE = {
 
  // ── FRIDAY MAY 15, 2026 ─────────────────────────────────────────
  // NBA: Two must-win G6 games tonight
  // MLB: 15 games across the country
  'Fri, May 15, 2026': {
    nba: [
      'DET @ CLE  7:00 PM ET  — Game 6, CLE leads series 3-2 (Donovan Mitchell 28pts avg, Cade Cunningham 25pts avg)',
      'SAS @ MIN  9:30 PM ET  — Game 6, SAS leads series 3-2 (Anthony Edwards 28+pts avg, De Aaron Fox leads SAS)'
    ],
    mlb: [
      'PIT @ PHI  6:40 PM ET',
      'BAL @ WSH  6:45 PM ET',
      'TOR @ DET  6:45 PM ET',
      'CIN @ CLE  7:10 PM ET',
      'MIA @ TB   7:10 PM ET',
      'MIL @ MIN  7:10 PM ET',
      'BOS @ ATL  7:15 PM ET',
      'NYY @ NYM  7:15 PM ET',
      'CHC @ CWS  7:40 PM ET',
      'TEX @ HOU  8:10 PM ET',
      'KC  @ STL  8:15 PM ET',
      'AZ  @ COL  8:40 PM ET',
      'LAD @ LAA  9:38 PM ET',
      'SD  @ SEA  9:40 PM ET',
      'SF  @ ATH  9:40 PM ET'
    ],
    wnba: [
      // WNBA season starts mid-May — check basketball_wnba via Odds API
    ],
    nhl: [],
    notes: 'Big NBA night — both series G6 elimination games. NYY @ NYM subway series.'
  },
 
  // ── SATURDAY MAY 16, 2026 ───────────────────────────────────────
  'Sat, May 16, 2026': {
    nba: [],
    mlb: [
      'TOR @ DET  1:10 PM ET',
      'AZ  @ COL  3:10 PM ET',
      'BAL @ WSH  4:05 PM ET',
      'BOS @ ATL  4:05 PM ET',
      'MIA @ TB   6:10 PM ET',
      'NYY @ NYM  7:15 PM ET',
      'TEX @ HOU  8:10 PM ET',
      'LAD @ LAA  9:38 PM ET',
      'SD  @ SEA  9:40 PM ET'
    ],
    nhl: [],
    notes: 'No NBA Saturday. G7s if needed are Sunday.'
  },
 
  // ── SUNDAY MAY 17, 2026 ─────────────────────────────────────────
  'Sun, May 17, 2026': {
    nba: [
      'POSSIBLE G7: DET vs CLE — only if series tied 3-3 after Friday',
      'POSSIBLE G7: SAS vs MIN — only if series tied 3-3 after Friday'
    ],
    mlb: [
      'NYY @ NYM  1:35 PM ET',
      'LAD @ LAA  4:07 PM ET',
      'SD  @ SEA  4:10 PM ET',
      'AZ  @ COL  3:10 PM ET'
    ],
    nhl: [],
    notes: 'NBA G7s only if series went to 7.'
  }
 
};
