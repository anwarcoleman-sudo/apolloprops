/*
 * ApolloProps API Server
 * ======================
 * Your Anthropic API key stays HERE — never in the browser files.
 *
 * Railway env vars to set:
 *   ANTHROPIC_API_KEY = sk-ant-...
 *
 * To update picks for new dates: edit GAME_SCHEDULE below.
 * To update the record: edit /api/record below.
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
  res.header('Access-Control-Max-Age', '86400');
  res.sendStatus(200);
});
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  next();
});
app.use(cors({ origin: '*', optionsSuccessStatus: 200 }));
 
// ── ANTHROPIC ─────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL         = 'claude-sonnet-4-20250514';
 
async function callClaude(body) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  console.log('Calling Anthropic:', MODEL, 'max_tokens:', body.max_tokens);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: MODEL, ...body })
  });
  console.log('Anthropic status:', r.status);
  if (!r.ok) {
    const err = await r.text();
    console.error('Anthropic error:', err);
    throw new Error('Anthropic API error ' + r.status + ': ' + err);
  }
  return r.json();
}
 
function getText(data) {
  return data.content?.map(c => c.text || '').join('') || '';
}
 
function parseJSON(text, fallback) {
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch(e) {
    console.error('JSON parse error:', e.message, '\nText:', text.slice(0, 300));
    return fallback;
  }
}
 
// ── DAILY CACHE ───────────────────────────────────────────────────────────
// Picks generate ONCE per day. Everyone gets cached picks after the first load.
// Cache auto-clears at midnight ET.
const cache = { date: null, picks: {}, potd: null, potdDate: null };
 
function getTodayET() {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  });
}
function isCacheValid() { return cache.date && cache.date === getTodayET(); }
 
function clearAtMidnight() {
  const now    = new Date();
  const etNow  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etNext = new Date(etNow); etNext.setHours(24, 0, 0, 0);
  const ms     = etNext - etNow;
  setTimeout(() => {
    cache.date = null; cache.picks = {}; cache.potd = null; cache.potdDate = null;
    console.log('Cache cleared at midnight ET');
    clearAtMidnight();
  }, ms);
  console.log('Cache clears in ' + Math.round(ms / 60000) + ' minutes');
}
clearAtMidnight();
 
// ── GAME SCHEDULE ─────────────────────────────────────────────────────────
// Update this weekly. Keys must match getTodayET() format exactly.
// Example: 'Thu, May 14, 2026'
//
// HOW TO ADD A NEW DATE:
//   1. Find the date string by visiting your Railway health endpoint and reading "today_et"
//   2. Add a new block below with that exact string as the key
//   3. Push to GitHub — Railway redeploys automatically
//
// NBA SERIES STATUS (update as games are played):
//   CLE leads DET 3-2  (CLE won G5 117-113 on May 13)
//   SAS leads MIN 3-2  (SAS won G5 126-97 on May 12)
//   OKC swept LAL 4-0  — DO NOT pick OKC or LAL
//   NYK swept PHI 4-0  — DO NOT pick NYK or PHI
 
const SCHEDULE = {
 
  'Thu, May 14, 2026': {
    nba: [],
    mlb: [
      'PIT @ COL 12:35 PM ET', 'CIN @ WSH 12:40 PM ET', 'DET @ NYM 1:10 PM ET',
      'SD @ MIL 1:40 PM ET',   'MIA @ MIN 1:40 PM ET',  'SEA @ HOU 2:10 PM ET',
      'STL @ ATH 3:05 PM ET',  'PHI @ BOS 6:45 PM ET',  'CHC @ ATL 7:15 PM ET',
      'KC @ CWS 7:40 PM ET',   'LAD @ SF 10:10 PM ET'
    ],
    nhl: [],
    notes: 'No NBA today. No NYY or BAL today.'
  },
 
  'Fri, May 15, 2026': {
    nba: [
      'DET @ CLE G6 7:00 PM ET — CLE leads series 3-2 (Donovan Mitchell avg 28pts, Cade Cunningham avg 25pts)',
      'SAS @ MIN G6 9:30 PM ET — SAS leads series 3-2 (Anthony Edwards avg 28+pts, De Aaron Fox leads SAS)'
    ],
    mlb: [
      'PIT @ PHI 6:40 PM ET',  'BAL @ WSH 6:45 PM ET',  'TOR @ DET 6:45 PM ET',
      'MIL @ MIN 7:10 PM ET',  'CIN @ CLE 7:10 PM ET',  'MIA @ TB 7:10 PM ET',
      'BOS @ ATL 7:15 PM ET',  'NYY @ NYM 7:15 PM ET',  'CHC @ CWS 7:40 PM ET',
      'TEX @ HOU 8:10 PM ET',  'KC @ STL 8:15 PM ET',   'AZ @ COL 8:40 PM ET',
      'LAD @ LAA 9:38 PM ET',  'SD @ SEA 9:40 PM ET',   'SF @ ATH 9:40 PM ET'
    ],
    nhl: [],
    notes: 'Big NBA night — two G6 games. NYY plays NYM tonight.'
  },
 
  'Sat, May 16, 2026': {
    nba: [],
    mlb: [
      'TOR @ DET 1:10 PM ET',  'KC @ STL 2:15 PM ET',
      'AZ @ COL 3:10 PM ET',   'BAL @ WSH 4:05 PM ET',
      'BOS @ ATL 4:05 PM ET',  'MIA @ TB 6:10 PM ET',
      'NYY @ NYM 7:15 PM ET',  'TEX @ HOU 8:10 PM ET',
      'LAD @ LAA 9:38 PM ET',  'SD @ SEA 9:40 PM ET'
    ],
    nhl: [],
    notes: 'No NBA Saturday. G7s if needed are Sunday May 17.'
  },
 
  'Sun, May 17, 2026': {
    nba: [
      'POSSIBLE G7: DET vs CLE — only if series tied 3-3 after Friday',
      'POSSIBLE G7: SAS vs MIN — only if series tied 3-3 after Friday'
    ],
    mlb: [
      'TOR @ DET 1:10 PM ET',  'KC @ STL 1:15 PM ET',
      'AZ @ COL 3:10 PM ET',   'NYY @ NYM 7:08 PM ET',
      'LAD @ LAA 4:07 PM ET',  'SD @ SEA 4:10 PM ET'
    ],
    nhl: [],
    notes: 'NBA G7s only if both series went to 7 games on Friday.'
  }
 
};
 
function getSchedule(dateStr) {
  return SCHEDULE[dateStr] || { nba: [], mlb: [], nhl: [], notes: 'Schedule TBD for this date.' };
}
 
function buildContext(dateStr, sport) {
  const s = getSchedule(dateStr);
  let ctx = '';
 
  // NBA
  if (sport === 'nba' || sport === 'all') {
    if (s.nba.length) {
      ctx += 'NBA GAMES TODAY:\n' + s.nba.join('\n') + '\n\n';
      ctx += 'NBA RULES: OKC swept LAL — no OKC/LAL picks. NYK swept PHI — no NYK/PHI picks.\n\n';
    } else {
      ctx += 'NO NBA GAMES TODAY. Generate 0 NBA picks.\n\n';
    }
  }
 
  // MLB
  if (sport === 'mlb' || sport === 'all') {
    if (s.mlb.length) {
      ctx += 'MLB GAMES TODAY:\n' + s.mlb.join('\n') + '\n\n';
      ctx += 'MLB RULE: Only pick players from teams listed above. Never invent matchups.\n\n';
    } else {
      ctx += 'NO MLB GAMES TODAY. Generate 0 MLB picks.\n\n';
    }
  }
 
  if (s.notes) ctx += 'NOTE: ' + s.notes + '\n';
  ctx += 'NO NHL games this week.\n';
  return ctx;
}
 
// ── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const todayET = getTodayET();
  res.json({
    status:       'ApolloProps API is running',
    time:         new Date().toISOString(),
    key_set:      !!ANTHROPIC_KEY,
    today_et:     todayET,
    schedule_for_today: getSchedule(todayET),
    cache_valid:  isCacheValid(),
    picks_cached: Object.fromEntries(Object.entries(cache.picks).map(([k,v])=>[k,v.length])),
    potd_cached:  !!cache.potd
  });
});
 
app.get('/api/ask-apollo',    (req, res) => res.json({ status: 'ok', method: 'POST required' }));
app.get('/api/generate-picks',(req, res) => res.json({ status: 'ok', method: 'POST required' }));
 
// ── POST /api/ask-apollo ──────────────────────────────────────────────────
app.post('/api/ask-apollo', async (req, res) => {
  try {
    const { system, messages, max_tokens } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages required' });
    const data = await callClaude({
      max_tokens: max_tokens || 1000,
      system:     system || 'You are Apollo, a sharp sports analyst.',
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
 
  // Serve from cache if available
  if (isCacheValid() && cache.picks[sport]) {
    console.log('Serving cached picks for', sport, '—', cache.picks[sport].length, 'picks');
    return res.json({ picks: cache.picks[sport], date: todayET, cached: true });
  }
  if (isCacheValid() && cache.picks['all'] && sport !== 'all') {
    const filtered = cache.picks['all'].filter(p => p.sport === sport);
    if (filtered.length) {
      console.log('Filtered from all cache:', filtered.length, sport, 'picks');
      return res.json({ picks: filtered, date: todayET, cached: true });
    }
  }
 
  console.log('Generating fresh picks — sport:', sport, 'date:', todayET);
 
  const gameContext = buildContext(todayET, sport);
 
  const systemPrompt = 'You are ApolloProps, an AI sports pick generator. '
    + 'Your job is to OUTPUT picks as JSON data — not to analyze or ask for more information. '
    + 'You already have everything you need: the game schedule is provided below. '
    + 'Use your training knowledge of player stats, team trends, and historical performance to assign lines, confidence scores, and reasons. '
    + 'You do NOT need real-time odds. Estimate reasonable lines based on your knowledge. '
    + 'NEVER say you need more data. NEVER refuse. ALWAYS return JSON picks. '
    + 'Today is ' + todayET + '.\n\n'
    + gameContext
    + '\nNBA SERIES CONTEXT (use this for NBA picks):\n'
    + 'CLE vs DET: CLE leads 3-2. Donovan Mitchell averaging 28pts, Evan Mobley 10reb. Cade Cunningham 25pts for DET.\n'
    + 'SAS vs MIN: SAS leads 3-2. Anthony Edwards 28+pts avg, Rudy Gobert 13reb. De Aaron Fox leads SAS scoring.\n'
    + 'OKC swept LAL — series over. NYK swept PHI — series over. Do not pick those teams.\n'
    + '\nMLB CONTEXT: Use your knowledge of starting pitchers, batting averages, bullpen ERA, and park factors for the teams listed.\n'
    + '\nReturn ONLY this JSON format, no markdown, no explanation, no refusals:\n'
    + '{"picks":[{"id":"p1","player":"Full Name","team":"ABBR","opp":"ABBR",'
    + '"sport":"nba|mlb","time":"7:00 PM ET",'
    + '"propType":"pts|reb|ast|hits|tb|hr|rbi|str|sok|ml|spread|total",'
    + '"propLabel":"Points","line":24.5,"direction":"over|under",'
    + '"last5":[true,false,true,true,false],"confidence":78,'
    + '"reason":"12 words max using real player trend",'
    + '"recentScores":["23","28","31"],"gameKey":"CLE-DET","gameLabel":"CLE vs DET (G6)","odds":"-115"}]}';
 
  // Sport-specific instructions
  // Build the user message with EXPLICIT game list embedded
  // This prevents Claude from saying "I don't have today's schedule"
  const schedule = getSchedule(todayET);
  let instructions = '';
 
  if (sport === 'nba') {
    if (schedule.nba.length) {
      instructions = 'OUTPUT 8 NBA picks as JSON. Games tonight:\n' + schedule.nba.join('\n') +
        '\n\nRequired: 5 player props (pts/reb/ast), 2 team picks (ML or total), 1 spread. ' +
        'Use your knowledge of these players\' recent performance. Estimate lines. Return JSON only.';
    } else {
      instructions = 'There are no NBA games tonight. Return exactly: {"picks":[]}';
    }
  } else if (sport === 'mlb') {
    if (schedule.mlb.length) {
      instructions = 'OUTPUT 12 MLB picks as JSON. Games today:\n' + schedule.mlb.join('\n') +
        '\n\nRequired: 4 pitcher strikeout props, 4 batter props (hits/total bases/HR), 2 team moneylines, 2 game totals. ' +
        'Use your knowledge of starting pitchers and batting trends for these teams. Estimate lines. Return JSON only.';
    } else {
      instructions = 'There are no MLB games today. Return exactly: {"picks":[]}';
    }
  } else if (sport === 'nhl') {
    instructions = 'There are no NHL games this week. Return exactly: {"picks":[]}';
  } else {
    // all sports — embed full game list
    const hasNBA = schedule.nba.length > 0;
    const hasMLB = schedule.mlb.length > 0;
    if (!hasNBA && !hasMLB) {
      instructions = 'There are no games today across any sport. Return exactly: {"picks":[]}';
    } else {
      let gameList = '';
      if (hasNBA) gameList += 'NBA GAMES TONIGHT:\n' + schedule.nba.join('\n') + '\n\n';
      if (hasMLB) gameList += 'MLB GAMES TODAY:\n' + schedule.mlb.join('\n') + '\n\n';
      if (!hasNBA) gameList += 'NO NBA games today.\n\n';
      if (!hasMLB) gameList += 'NO MLB games today.\n\n';
 
      const nbaInstr = hasNBA ? '8 NBA picks (5 player props, 2 team picks, 1 spread)' : '0 NBA picks';
      const mlbInstr = hasMLB ? '8 MLB picks (3 pitcher Ks, 3 batter props, 1 ML, 1 total)' : '0 MLB picks';
 
      instructions = 'OUTPUT picks as JSON. ' + gameList +
        'Required output: ' + nbaInstr + ' AND ' + mlbInstr + '. ' +
        'Use your knowledge of these teams and players. Estimate realistic lines. ' +
        'Do not ask for more data. Do not refuse. Return JSON only.';
    }
  }
 
  try {
    const data = await callClaude({
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: instructions }]
    });
    const raw   = getText(data);
    console.log('Raw response (first 400):', raw.slice(0, 400));
    const result = parseJSON(raw, { picks: [] });
    const valid  = (result.picks || []).filter(p =>
      p.player && p.sport && p.propType && p.line !== undefined && p.direction
    );
    console.log('Valid picks:', valid.length);
 
    // Store in cache
    if (!isCacheValid()) { cache.date = getTodayET(); cache.picks = {}; }
    cache.picks[sport] = valid;
    if (sport === 'all') {
      ['nba','mlb','nhl'].forEach(s => { cache.picks[s] = valid.filter(p => p.sport === s); });
    }
    console.log('Cached', valid.length, 'picks for', sport, 'on', cache.date);
 
    res.json({ picks: valid, date: getTodayET(), cached: false });
  } catch(e) {
    console.error('/api/generate-picks error:', e.message);
    res.json({ picks: [] });
  }
});
 
// ── GET /api/pick-of-day ──────────────────────────────────────────────────
app.get('/api/pick-of-day', async (req, res) => {
  const todayET = getTodayET();
 
  // Use cached POTD
  if (cache.potd && cache.potdDate === todayET) {
    console.log('Serving cached POTD');
    return res.json({ pick: cache.potd, cached: true });
  }
 
  // Derive from cached picks if available
  if (isCacheValid() && cache.picks['all']?.length) {
    const top = [...cache.picks['all']].sort((a,b) => b.confidence - a.confidence)[0];
    cache.potd = top; cache.potdDate = todayET;
    console.log('POTD derived from cache:', top.player);
    return res.json({ pick: top, cached: true });
  }
 
  // Generate from today's schedule
  const schedule = getSchedule(todayET);
  const games    = [...(schedule.nba || []), ...(schedule.mlb || [])];
  const gamesCtx = games.length ? games.join(', ') : 'no games today';
 
  try {
    const data = await callClaude({
      max_tokens: 400,
      system: 'Sports betting analyst. Today: ' + todayET + '. Games: ' + gamesCtx + '. '
            + 'Return the single best pick as JSON only: '
            + '{"pick":{"player":"","team":"","opp":"","sport":"nba|mlb","time":"",'
            + '"propType":"hits","propLabel":"Hits","line":0,"direction":"over",'
            + '"confidence":0,"odds":"","last5":[true,true,false,true,true],"reason":""}}',
      messages: [{ role: 'user', content: 'What is the single best play today? Pick one specific player or team bet from the games listed.' }]
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
  // Serve from cache if picks already generated today
  if (isCacheValid() && cache.picks['all']?.length) {
    const preview = cache.picks['all'].slice(0, 5);
    return res.json({ picks: preview, total: cache.picks['all'].length, cached: true });
  }
 
  const todayET = getTodayET();
  const schedule = getSchedule(todayET);
  const games    = [...(schedule.nba || []), ...(schedule.mlb || [])].slice(0, 5);
 
  try {
    const data = await callClaude({
      max_tokens: 500,
      system: 'Sports betting data. Today: ' + todayET + '. Games: ' + games.join(', ') + '. '
            + 'Return 5 picks as JSON only: '
            + '{"picks":[{"player":"","team":"","opp":"","sport":"nba|mlb","time":"",'
            + '"propType":"pts","propLabel":"Points","line":0,"direction":"over|under",'
            + '"confidence":0,"last5":[true,false,true,true,false]}],"total":15}',
      messages: [{ role: 'user', content: 'Generate 5 preview picks from todays games.' }]
    });
    const result = parseJSON(getText(data), { picks: [], total: 15 });
    res.json(result);
  } catch(e) {
    console.error('/api/picks-preview error:', e.message);
    res.json({ picks: [], total: 15 });
  }
});
 
// ── GET /api/record ───────────────────────────────────────────────────────
// UPDATE these numbers as your real record builds
app.get('/api/record', (req, res) => {
  res.json({ wins: 18, losses: 9, pct: 67, units: 6.2 });
});
 
// ── POST /api/resolve-results ─────────────────────────────────────────────
app.post('/api/resolve-results', async (req, res) => {
  const picks = req.body.picks || [];
  if (!picks.length) return res.json({ results: [] });
  const list = picks.map((p,i) =>
    (i+1) + '. ID:' + p.id + ' | ' + p.sport.toUpperCase() + ' | ' + p.player +
    ' | ' + p.direction.toUpperCase() + ' ' + p.line + ' ' + p.propType +
    ' | ' + p.gameLabel + ' | ' + p.loggedDate
  ).join('\n');
  try {
    const data = await callClaude({
      max_tokens: 600,
      system: 'Sports results verifier. Today: ' + new Date().toDateString() + '. '
            + 'Check if these picks won or lost based on actual game results. '
            + 'Mark pending if game has not happened yet. '
            + 'Return JSON only: {"results":[{"id":"...","result":"win|loss|pending|unknown","actual":"8 words max"}]}',
      messages: [{ role: 'user', content: 'Check results:\n' + list }]
    });
    res.json(parseJSON(getText(data), { results: [] }));
  } catch(e) {
    console.error('/api/resolve-results error:', e.message);
    res.json({ results: [] });
  }
});
 
// ── GET /api/schedule ────────────────────────────────────────────────────
// Returns today's game slate so the machine can display real games
app.get('/api/schedule', (req, res) => {
  const todayET  = getTodayET();
  const schedule = getSchedule(todayET);
 
  // If no NBA today, find the next date that has NBA games
  let nextNBA = null;
  if(!schedule.nba || !schedule.nba.length){
    const allDates = Object.keys(SCHEDULE).sort();
    for(const d of allDates){
      if(d > todayET && SCHEDULE[d].nba && SCHEDULE[d].nba.length){
        nextNBA = { date: d, games: SCHEDULE[d].nba };
        break;
      }
    }
  }
 
  // If no MLB today, find the next date that has MLB games
  let nextMLB = null;
  if(!schedule.mlb || !schedule.mlb.length){
    const allDates = Object.keys(SCHEDULE).sort();
    for(const d of allDates){
      if(d > todayET && SCHEDULE[d].mlb && SCHEDULE[d].mlb.length){
        nextMLB = { date: d, games: SCHEDULE[d].mlb };
        break;
      }
    }
  }
 
  res.json({
    date:     todayET,
    nba:      schedule.nba  || [],
    mlb:      schedule.mlb  || [],
    nhl:      schedule.nhl  || [],
    notes:    schedule.notes || '',
    nbaCount: (schedule.nba  || []).length,
    mlbCount: (schedule.mlb  || []).length,
    nhlCount: (schedule.nhl  || []).length,
    nextNBA:  nextNBA,
    nextMLB:  nextMLB
  });
});
 
// ── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('ApolloProps API running on port ' + PORT);
  console.log('API key set: ' + !!ANTHROPIC_KEY);
  console.log('Today ET: ' + getTodayET());
  console.log('CORS: open to all origins');
});
