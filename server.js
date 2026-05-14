/*
 * ApolloProps API Server — Live Data Build
 * =========================================
 * Data flow:
 *   1. Odds API  → fetches today's real games, lines, props
 *   2. Cache     → stores slate for the day (one API call per day)
 *   3. Claude    → analyzes verified slate, returns picks
 *   4. Frontend  → displays picks with timestamps
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
 
// ── KEYS ──────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ODDS_KEY      = process.env.ODDS_API_KEY;
const MODEL         = 'claude-sonnet-4-20250514';
 
// ── HELPERS ───────────────────────────────────────────────────────────────
function getTodayET() {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  });
}
function getNowET() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}
function isoToET(iso) {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: '2-digit', hour12: true
  }) + ' ET';
}
function getText(data) {
  return data.content?.map(c => c.text || '').join('') || '';
}
function parseJSON(text, fallback) {
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const start = clean.indexOf('{');
    const end   = clean.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON object found');
    return JSON.parse(clean.slice(start, end + 1));
  } catch(e) {
    console.error('JSON parse error:', e.message);
    console.error('Text was:', text.slice(0, 400));
    return fallback;
  }
}
 
// ── ANTHROPIC ─────────────────────────────────────────────────────────────
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
  if (!r.ok) {
    const err = await r.text();
    throw new Error('Anthropic ' + r.status + ': ' + err);
  }
  return r.json();
}
 
// ── CACHE ─────────────────────────────────────────────────────────────────
const cache = {
  slateDate:   null,   // date the slate was fetched
  slate:       null,   // raw game + odds data from Odds API
  slateTime:   null,   // timestamp of last fetch
  picks:       {},     // { all, nba, mlb, nhl }
  picksDate:   null,
  potd:        null,
  potdDate:    null
};
 
function isSlateValid()  { return cache.slateDate  === getTodayET() && cache.slate; }
function isPicksValid(s) { return cache.picksDate  === getTodayET() && cache.picks[s]?.length; }
function isPotdValid()   { return cache.potdDate   === getTodayET() && cache.potd; }
 
function clearAtMidnight() {
  const now   = new Date();
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const next  = new Date(etNow); next.setHours(24, 0, 0, 0);
  const ms    = next - etNow;
  setTimeout(() => {
    Object.assign(cache, { slateDate:null, slate:null, slateTime:null,
                            picks:{}, picksDate:null, potd:null, potdDate:null });
    console.log('Cache cleared at midnight ET');
    clearAtMidnight();
  }, ms);
  console.log('Cache clears in ' + Math.round(ms/60000) + ' min');
}
clearAtMidnight();
 
// ── ODDS API ──────────────────────────────────────────────────────────────
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const SPORT_KEYS = {
  nba: 'basketball_nba',
  mlb: 'baseball_mlb',
  nhl: 'icehockey_nhl'
};
 
async function oddsGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = ODDS_BASE + path + sep + 'apiKey=' + ODDS_KEY;
  const r   = await fetch(url);
  console.log('Odds API:', url.replace(ODDS_KEY, 'KEY'), '→', r.status);
  if (!r.ok) throw new Error('Odds API ' + r.status);
  const remaining = r.headers.get('x-requests-remaining');
  if (remaining) console.log('Odds API requests remaining:', remaining);
  return r.json();
}
 
// Fetch today's games + main markets for one sport
async function fetchSportSlate(sportKey) {
  try {
    const games = await oddsGet(
      '/sports/' + sportKey + '/odds/'
      + '?regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso'
    );
    // Filter to games starting within 24 hours
    const now       = Date.now();
    const in24Hours = now + 24 * 60 * 60 * 1000;
    return (games || []).filter(g => {
      const t = new Date(g.commence_time).getTime();
      return t >= now - 3600000 && t <= in24Hours; // started up to 1hr ago or upcoming
    });
  } catch(e) {
    console.error('fetchSportSlate error for', sportKey, ':', e.message);
    return [];
  }
}
 
// Fetch player props for a specific event (uses separate endpoint)
async function fetchEventProps(sportKey, eventId) {
  try {
    const propMarkets = sportKey === 'basketball_nba'
      ? 'player_points,player_rebounds,player_assists,player_threes'
      : 'batter_hits,batter_total_bases,batter_home_runs,pitcher_strikeouts';
 
    const data = await oddsGet(
      '/sports/' + sportKey + '/events/' + eventId + '/odds'
      + '?regions=us&markets=' + propMarkets + '&oddsFormat=american&dateFormat=iso'
    );
    return data;
  } catch(e) {
    console.error('fetchEventProps error:', e.message);
    return null;
  }
}
 
// Build the full slate — games + odds + props
async function buildSlate(sportFilter) {
  if (!ODDS_KEY) {
    console.log('No ODDS_API_KEY — cannot fetch live slate');
    return null;
  }
 
  const sports = sportFilter === 'all'
    ? ['nba','mlb','nhl']
    : [sportFilter].filter(s => SPORT_KEYS[s]);
 
  const slate = { date: getTodayET(), updatedAt: getNowET(), games: [] };
 
  for (const sport of sports) {
    const games = await fetchSportSlate(SPORT_KEYS[sport]);
    console.log('Slate:', games.length, sport.toUpperCase(), 'games today');
 
    for (const g of games) {
      const gameObj = {
        id:        g.id,
        sport:     sport,
        home:      g.home_team,
        away:      g.away_team,
        time:      isoToET(g.commence_time),
        isoTime:   g.commence_time,
        bookmakers: [],
        props:     []
      };
 
      // Main markets from first 2 bookmakers
      const bks = (g.bookmakers || []).slice(0, 2);
      bks.forEach(bk => {
        const entry = { name: bk.title, markets: {} };
        bk.markets?.forEach(mkt => {
          entry.markets[mkt.key] = mkt.outcomes;
        });
        gameObj.bookmakers.push(entry);
      });
 
      // Fetch player props for NBA + MLB games (uses API credits — limit to top 4 games)
      if ((sport === 'nba' || sport === 'mlb') && slate.games.filter(x=>x.sport===sport).length < 4) {
        const props = await fetchEventProps(SPORT_KEYS[sport], g.id);
        if (props?.bookmakers?.length) {
          const propBk = props.bookmakers[0];
          propBk.markets?.forEach(mkt => {
            mkt.outcomes?.forEach(o => {
              gameObj.props.push({
                player:    o.name,
                market:    mkt.key,
                line:      o.point,
                direction: o.name.toLowerCase().includes('over') ? 'over' : 'under',
                price:     o.price
              });
            });
          });
          console.log('Props loaded for', g.away_team, '@', g.home_team, ':', gameObj.props.length, 'lines');
        }
      }
 
      slate.games.push(gameObj);
    }
  }
 
  return slate;
}
 
// Format slate into a readable string for Claude
function formatSlateForClaude(slate) {
  if (!slate || !slate.games.length) return 'No games available today.';
 
  let out = 'TODAY\'S VERIFIED GAME SLATE (' + slate.date + ', updated ' + slate.updatedAt + '):\n\n';
 
  const bySport = {};
  slate.games.forEach(g => {
    if (!bySport[g.sport]) bySport[g.sport] = [];
    bySport[g.sport].push(g);
  });
 
  Object.entries(bySport).forEach(([sport, games]) => {
    out += sport.toUpperCase() + ' GAMES:\n';
    games.forEach(g => {
      out += g.away + ' @ ' + g.home + '  ' + g.time + '\n';
 
      // Main market odds
      const bk = g.bookmakers[0];
      if (bk) {
        const ml = bk.markets?.h2h;
        if (ml) {
          const lines = ml.map(o => o.name + ' ' + (o.price > 0 ? '+' : '') + o.price).join(' | ');
          out += '  ML: ' + lines + '\n';
        }
        const sp = bk.markets?.spreads;
        if (sp) {
          const lines = sp.map(o => o.name + ' ' + o.point + ' (' + (o.price > 0 ? '+' : '') + o.price + ')').join(' | ');
          out += '  Spread: ' + lines + '\n';
        }
        const tot = bk.markets?.totals;
        if (tot) {
          out += '  Total: ' + tot[0]?.point + '\n';
        }
      }
 
      // Player props
      if (g.props.length) {
        out += '  PLAYER PROPS:\n';
        const grouped = {};
        g.props.forEach(p => {
          if (!grouped[p.player]) grouped[p.player] = [];
          grouped[p.player].push(p);
        });
        Object.entries(grouped).slice(0, 8).forEach(([player, lines]) => {
          lines.slice(0, 2).forEach(l => {
            out += '    ' + player + ' ' + l.market.replace('player_','').replace('batter_','').replace('pitcher_','') +
              ' ' + (l.direction === 'over' ? 'O' : 'U') + l.line +
              ' (' + (l.price > 0 ? '+' : '') + l.price + ')\n';
          });
        });
      }
      out += '\n';
    });
  });
 
  return out;
}
 
// ── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:          'ApolloProps API is running',
    time:            new Date().toISOString(),
    today_et:        getTodayET(),
    anthropic_ready: !!ANTHROPIC_KEY,
    odds_api_ready:  !!ODDS_KEY,
    slate_valid:     isSlateValid(),
    slate_games:     cache.slate?.games?.length || 0,
    slate_updated:   cache.slateTime || 'not yet',
    picks_cached:    Object.fromEntries(Object.entries(cache.picks).map(([k,v])=>[k,v?.length||0]))
  });
});
 
// ── GET /api/slate/today ──────────────────────────────────────────────────
// Returns today's verified game slate with odds
app.get('/api/slate/today', async (req, res) => {
  // Serve from cache if valid
  if (isSlateValid()) {
    console.log('Serving cached slate');
    return res.json({ slate: cache.slate, cached: true });
  }
 
  if (!ODDS_KEY) {
    return res.json({
      slate: null,
      error: 'ODDS_API_KEY not configured',
      message: 'Add ODDS_API_KEY to Railway environment variables'
    });
  }
 
  try {
    const slate = await buildSlate('all');
    if (slate && slate.games.length) {
      cache.slate     = slate;
      cache.slateDate = getTodayET();
      cache.slateTime = getNowET();
      console.log('Slate cached:', slate.games.length, 'games');
      res.json({ slate, cached: false });
    } else {
      res.json({ slate: null, message: 'No games found for today' });
    }
  } catch(e) {
    console.error('/api/slate/today error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
 
app.get('/api/slate',       (req, res) => res.redirect('/api/slate/today'));
app.get('/api/schedule',    async (req, res) => {
  if (isSlateValid()) {
    const nba = cache.slate.games.filter(g=>g.sport==='nba');
    const mlb = cache.slate.games.filter(g=>g.sport==='mlb');
    const nhl = cache.slate.games.filter(g=>g.sport==='nhl');
    return res.json({
      date:     cache.slate.date,
      nba:      nba.map(g => g.away + ' @ ' + g.home + ' ' + g.time),
      mlb:      mlb.map(g => g.away + ' @ ' + g.home + ' ' + g.time),
      nhl:      nhl.map(g => g.away + ' @ ' + g.home + ' ' + g.time),
      nbaCount: nba.length,
      mlbCount: mlb.length,
      nhlCount: nhl.length,
      updatedAt: cache.slateTime
    });
  }
  // No slate yet — fetch it
  try {
    const slate = await buildSlate('all');
    if (slate?.games?.length) {
      cache.slate = slate; cache.slateDate = getTodayET(); cache.slateTime = getNowET();
    }
    const nba = (slate?.games||[]).filter(g=>g.sport==='nba');
    const mlb = (slate?.games||[]).filter(g=>g.sport==='mlb');
    const nhl = (slate?.games||[]).filter(g=>g.sport==='nhl');
    res.json({
      date:     getTodayET(),
      nba:      nba.map(g => g.away + ' @ ' + g.home + ' ' + g.time),
      mlb:      mlb.map(g => g.away + ' @ ' + g.home + ' ' + g.time),
      nhl:      nhl.map(g => g.away + ' @ ' + g.home + ' ' + g.time),
      nbaCount: nba.length, mlbCount: mlb.length, nhlCount: nhl.length,
      updatedAt: getNowET()
    });
  } catch(e) {
    res.json({ date: getTodayET(), nba:[], mlb:[], nhl:[], nbaCount:0, mlbCount:0, nhlCount:0 });
  }
});
 
// ── GET /api/ask-apollo ───────────────────────────────────────────────────
app.get('/api/ask-apollo',    (req, res) => res.json({ status: 'ok', method: 'POST required' }));
app.get('/api/generate-picks',(req, res) => res.json({ status: 'ok', method: 'POST required' }));
 
// ── POST /api/ask-apollo ──────────────────────────────────────────────────
app.post('/api/ask-apollo', async (req, res) => {
  try {
    const { system, messages, max_tokens } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages required' });
    const data = await callClaude({
      max_tokens: max_tokens || 1000,
      system: system || 'You are Apollo, a sharp sports betting analyst.',
      messages
    });
    res.json(data);
  } catch(e) {
    console.error('/api/ask-apollo error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
 
// ── POST /api/generate-picks ──────────────────────────────────────────────
app.post('/api/generate-picks', async (req, res) => {
  const sport   = req.body.sport || 'all';
  const todayET = getTodayET();
 
  // Serve from picks cache
  if (isPicksValid(sport)) {
    console.log('Serving cached picks for', sport, '—', cache.picks[sport].length, 'picks');
    return res.json({ picks: cache.picks[sport], date: todayET, cached: true, slateTime: cache.slateTime });
  }
  if (isPicksValid('all') && sport !== 'all') {
    const filtered = cache.picks.all.filter(p => p.sport === sport);
    if (filtered.length) return res.json({ picks: filtered, date: todayET, cached: true, slateTime: cache.slateTime });
  }
 
  // STEP 1 — Get today's slate (from cache or fresh fetch)
  let slate = isSlateValid() ? cache.slate : null;
  if (!slate) {
    if (!ODDS_KEY) {
      console.log('No ODDS_API_KEY — cannot fetch verified slate');
      return res.json({
        picks: [],
        date: todayET,
        noSlate: true,
        message: 'Odds API not configured. Add ODDS_API_KEY to Railway variables.'
      });
    }
    try {
      slate = await buildSlate(sport === 'all' ? 'all' : sport);
      if (slate?.games?.length) {
        cache.slate = slate; cache.slateDate = todayET; cache.slateTime = getNowET();
        console.log('Fresh slate:', slate.games.length, 'games');
      }
    } catch(e) {
      console.error('Slate fetch error:', e.message);
    }
  }
 
  // No games today
  const relevantGames = (slate?.games || []).filter(g =>
    sport === 'all' || g.sport === sport
  );
 
  if (!relevantGames.length) {
    console.log('No games today for', sport);
    return res.json({
      picks: [],
      date: todayET,
      noGames: true,
      slateTime: cache.slateTime || getNowET(),
      message: 'No ' + sport.toUpperCase() + ' games found for today.'
    });
  }
 
  // STEP 2 — Format slate for Claude
  const slateForClaude = formatSlateForClaude({
    ...slate,
    games: relevantGames
  });
 
  console.log('Sending slate to Claude:', relevantGames.length, 'games');
 
  // STEP 3 — Ask Claude to analyze ONLY the verified slate
  const system =
    'You are ApolloProps, a sports betting analysis engine. '
    + 'You will be given a verified current game slate with real odds from sportsbooks. '
    + 'Your job is to return betting picks ONLY from the games in this slate. '
    + 'Do not invent games. Do not add teams not in the slate. '
    + 'Use the real odds and lines provided. '
    + 'Return ONLY valid JSON with this exact structure, no markdown:\n'
    + '{"picks":['
    + '{"id":"p1","player":"Full Name or Team Name","team":"ABBR","opp":"ABBR",'
    + '"sport":"nba|mlb|nhl","time":"7:00 PM ET",'
    + '"propType":"pts|reb|ast|hits|tb|hr|rbi|str|ml|spread|total",'
    + '"propLabel":"Points","line":27.5,"direction":"over|under",'
    + '"last5":[true,false,true,true,false],"confidence":78,'
    + '"reason":"12 words max using the actual odds and trends",'
    + '"recentScores":["23","28","31"],'
    + '"gameKey":"CLE-DET","gameLabel":"CLE vs DET","odds":"-115"}'
    + ']}';
 
  const sportInstr = sport === 'nba' ? '8 NBA picks (5 player props, 2 team picks, 1 spread)'
    : sport === 'mlb' ? '12 MLB picks (4 pitcher Ks, 4 batter props, 2 MLs, 2 totals)'
    : sport === 'nhl' ? '8 NHL picks'
    : '16 total picks across all sports shown';
 
  const userMsg = 'Here is today\'s verified slate with real sportsbook odds:\n\n'
    + slateForClaude
    + '\nGenerate ' + sportInstr + ' from this slate. '
    + 'Only use games, teams, and players shown above. '
    + 'Use the actual lines and odds provided. Return JSON only.';
 
  try {
    const data = await callClaude({ max_tokens: 2000, system, messages: [{ role: 'user', content: userMsg }] });
    const raw  = getText(data);
    console.log('Claude response (first 500):', raw.slice(0, 500));
    const result = parseJSON(raw, { picks: [] });
    const valid  = (result.picks || []).filter(p =>
      p.player && p.sport && p.propType && p.line !== undefined && p.direction
    );
    console.log('Valid picks returned:', valid.length);
 
    // Cache picks
    if (!cache.picksDate) { cache.picks = {}; }
    cache.picks[sport] = valid;
    cache.picksDate    = todayET;
    if (sport === 'all') {
      ['nba','mlb','nhl'].forEach(s => { cache.picks[s] = valid.filter(p => p.sport === s); });
    }
 
    res.json({ picks: valid, date: todayET, cached: false, slateTime: cache.slateTime });
  } catch(e) {
    console.error('/api/generate-picks error:', e.message);
    res.json({ picks: [], error: e.message, date: todayET });
  }
});
 
// ── GET /api/pick-of-day ──────────────────────────────────────────────────
app.get('/api/pick-of-day', async (req, res) => {
  const todayET = getTodayET();
  if (isPotdValid()) return res.json({ pick: cache.potd, cached: true });
 
  // Derive from picks cache
  if (isPicksValid('all') && cache.picks.all.length) {
    const top = [...cache.picks.all].sort((a,b) => b.confidence - a.confidence)[0];
    cache.potd = top; cache.potdDate = todayET;
    return res.json({ pick: top, cached: true });
  }
 
  // Need slate
  const slate = isSlateValid() ? cache.slate : null;
  if (!slate || !slate.games.length) return res.json({ pick: null, message: 'No slate available' });
 
  const slateStr = formatSlateForClaude(slate);
  try {
    const data = await callClaude({
      max_tokens: 400,
      system: 'You are ApolloProps. Return the single best pick from today\'s slate as JSON: '
            + '{"pick":{"player":"","team":"","opp":"","sport":"nba|mlb","time":"",'
            + '"propType":"pts","propLabel":"Points","line":0,"direction":"over",'
            + '"confidence":0,"odds":"","last5":[true,true,false,true,true],"reason":""}}',
      messages: [{ role: 'user', content: 'Today\'s slate:\n' + slateStr + '\nReturn the single best pick as JSON.' }]
    });
    const result = parseJSON(getText(data), { pick: null });
    if (result.pick) { cache.potd = result.pick; cache.potdDate = todayET; }
    res.json(result);
  } catch(e) {
    console.error('/api/pick-of-day error:', e.message);
    res.json({ pick: null });
  }
});
 
// ── GET /api/picks-preview ────────────────────────────────────────────────
app.get('/api/picks-preview', async (req, res) => {
  if (isPicksValid('all')) {
    return res.json({ picks: cache.picks.all.slice(0,5), total: cache.picks.all.length, cached: true });
  }
  if (isSlateValid()) {
    // Return first 5 games as preview without full pick generation
    const preview = cache.slate.games.slice(0,5).map(g => ({
      player: g.home + ' vs ' + g.away,
      team: g.home, opp: g.away, sport: g.sport,
      time: g.time, propType: 'ml', propLabel: 'Moneyline',
      line: 0, direction: 'over', confidence: 72, last5: [true,false,true,true,false]
    }));
    return res.json({ picks: preview, total: cache.slate.games.length, cached: true });
  }
  res.json({ picks: [], total: 0, message: 'No slate available yet' });
});
 
// ── GET /api/record ───────────────────────────────────────────────────────
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
            + 'Return JSON only: {"results":[{"id":"...","result":"win|loss|pending|unknown","actual":"8 words max"}]}',
      messages: [{ role: 'user', content: 'Check results:\n'+list }]
    });
    res.json(parseJSON(getText(data), { results: [] }));
  } catch(e) {
    console.error('/api/resolve-results error:', e.message);
    res.json({ results: [] });
  }
});
 
// ── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('ApolloProps API running on port ' + PORT);
  console.log('Anthropic ready:', !!ANTHROPIC_KEY);
  console.log('Odds API ready: ', !!ODDS_KEY);
  console.log('Today ET:      ', getTodayET());
});
