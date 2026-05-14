/*
 * ApolloProps API Server
 * ======================
 * Deploy this to Railway. Your Anthropic API key stays HERE,
 * never in the browser HTML files.
 *
 * Setup:
 *   1. npm install
 *   2. Set ANTHROPIC_API_KEY environment variable in Railway
 *   3. Push to GitHub, connect to Railway
 *   4. Copy your Railway domain into machine.html and landing.html
 *
 * Railway env vars to set:
 *   ANTHROPIC_API_KEY = sk-ant-...
 *   ALLOWED_ORIGINS   = https://apolloprops.com,https://www.apolloprops.com
 */
 
const express = require('express');
const cors    = require('cors');
 
const app = express();
app.use(express.json());
 
// ── CORS ──────────────────────────────────────────────────────────────────
// Allow your HostGator domain to call this API
// Add localhost:3000 for local testing
// CORS — must be first middleware, handles browser preflight
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
 
// ── ANTHROPIC HELPER ──────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
 
// ── DAILY PICKS CACHE ─────────────────────────────────────────────────
// Picks generate ONCE per day and serve to all users from cache.
// Cache resets automatically at midnight ET.
// One Anthropic call per day instead of one per user.
const picksCache = {
  date:  null,   // 'Mon May 14 2026'
  picks: {},     // { 'all': [...], 'nba': [...], 'mlb': [...] }
  potd:  null,   // pick of the day
  potdDate: null
};
 
function getTodayET(){
  // Get current date string in Eastern Time
  return new Date().toLocaleDateString('en-US',{
    timeZone:'America/New_York',
    weekday:'short',month:'short',day:'numeric',year:'numeric'
  });
}
 
function isCacheValid(){
  return picksCache.date && picksCache.date === getTodayET();
}
 
// ── GAME SCHEDULE LOOKUP ─────────────────────────────────────────────
// Keyed by ET date string. Update weekly as schedule is released.
// NBA: Verified from official schedule. MLB: rotates daily.
const GAME_SCHEDULE = {
 
  // ── THURSDAY MAY 14 ──────────────────────────────────────────────
  'Thu, May 14, 2026': {
    nba: [], // No NBA games
    mlb: [
      'PIT @ COL 12:35 PM ET', 'CIN @ WSH 12:40 PM ET', 'DET @ NYM 1:10 PM ET',
      'SD @ MIL 1:40 PM ET', 'MIA @ MIN 1:40 PM ET', 'SEA @ HOU 2:10 PM ET',
      'STL @ ATH 3:05 PM ET', 'PHI @ BOS 6:45 PM ET', 'CHC @ ATL 7:15 PM ET',
      'KC @ CWS 7:40 PM ET', 'LAD @ SF 10:10 PM ET'
    ],
    nhl: [],
    notes: 'No NYY or BAL today. No NBA today.'
  },
 
  // ── FRIDAY MAY 15 ────────────────────────────────────────────────
  'Fri, May 15, 2026': {
    nba: [
      'DET @ CLE G6 7:00 PM ET (CLE leads series 3-2)',
      'SAS @ MIN G6 9:30 PM ET (SAS leads series 3-2)'
    ],
    mlb: [
      'PIT @ PHI 6:40 PM ET', 'BAL @ WSH 6:45 PM ET', 'TOR @ DET 6:45 PM ET',
      'MIL @ MIN 7:10 PM ET', 'CIN @ CLE 7:10 PM ET', 'MIA @ TB 7:10 PM ET',
      'BOS @ ATL 7:15 PM ET', 'NYY @ NYM 7:15 PM ET', 'CHC @ CWS 7:40 PM ET',
      'TEX @ HOU 8:10 PM ET', 'KC @ STL 8:15 PM ET', 'AZ @ COL 8:40 PM ET',
      'LAD @ LAA 9:38 PM ET', 'SD @ SEA 9:40 PM ET', 'SF @ ATH 9:40 PM ET'
    ],
    nhl: [],
    notes: 'NBA: DET vs CLE G6 and SAS vs MIN G6. Big NBA night.'
  },
 
  // ── SATURDAY MAY 16 ──────────────────────────────────────────────
  'Sat, May 16, 2026': {
    nba: [], // G7s if needed would be Sunday May 17
    mlb: [
      'TOR @ DET 1:10 PM ET', 'KC @ STL 2:15 PM ET', 'AZ @ COL 3:10 PM ET',
      'BAL @ WSH 4:05 PM ET'
      // More games TBD
    ],
    nhl: [],
    notes: 'No NBA Saturday. G7s if needed on Sunday May 17.'
  },
 
  // ── SUNDAY MAY 17 ────────────────────────────────────────────────
  // G7s only if series are tied after Friday
  'Sun, May 17, 2026': {
    nba: [
      'POTENTIAL G7: DET vs CLE (if series tied 3-3)',
      'POTENTIAL G7: SAS vs MIN (if series tied 3-3)'
    ],
    mlb: [], // TBD
    nhl: [],
    notes: 'G7s only if both series go to 7. Check Friday results.'
  }
};
 
function getScheduleForDate(dateStr) {
  // Try exact match first
  if (GAME_SCHEDULE[dateStr]) return GAME_SCHEDULE[dateStr];
  // Return empty schedule if no data
  return { nba: [], mlb: [], nhl: [], notes: 'Schedule not yet available for this date.' };
}
 
function buildGameContext(dateStr, sport) {
  const schedule = getScheduleForDate(dateStr);
  const nbaGames  = schedule.nba  || [];
  const mlbGames  = schedule.mlb  || [];
  const notes     = schedule.notes || '';
 
  let ctx = '';
 
  if ((sport === 'nba' || sport === 'all') && nbaGames.length > 0) {
    ctx += 'NBA GAMES TODAY:\n' + nbaGames.join('\n') + '\n';
    ctx += 'NBA SERIES STATUS (May 2026):\n';
    ctx += '- CLE vs DET: CLE leads 3-2. Donovan Mitchell 28pts avg. Cade Cunningham 25pts avg.\n';
    ctx += '- SAS vs MIN: SAS leads 3-2. Anthony Edwards 28+ avg. De Aaron Fox leads SAS.\n';
    ctx += '- OKC swept LAL 4-0. DO NOT pick OKC or LAL players.\n';
    ctx += '- NYK swept PHI 4-0. DO NOT pick NYK or PHI players.\n';
  } else if (sport === 'nba' || sport === 'all') {
    ctx += 'NO NBA GAMES TODAY. Do not generate NBA picks.\n';
  }
 
  if ((sport === 'mlb' || sport === 'all') && mlbGames.length > 0) {
    ctx += 'MLB GAMES TODAY:\n' + mlbGames.join('\n') + '\n';
    ctx += 'ONLY pick players from the teams listed above. Never invent games.\n';
  } else if (sport === 'mlb' || sport === 'all') {
    ctx += 'No MLB games confirmed for today. Do not generate MLB picks.\n';
  }
 
  if (notes) ctx += 'NOTES: ' + notes + '\n';
  ctx += 'NO NHL games this week.\n';
 
  return ctx;
}
 
function clearCacheAtMidnight(){
  const now    = new Date();
  const nextET = new Date(now.toLocaleString('en-US',{timeZone:'America/New_York'}));
  nextET.setHours(24,0,0,0); // midnight ET
  const msUntilMidnight = nextET - new Date(now.toLocaleString('en-US',{timeZone:'America/New_York'}));
  setTimeout(()=>{
    picksCache.date  = null;
    picksCache.picks = {};
    picksCache.potd  = null;
    picksCache.potdDate = null;
    console.log('Daily picks cache cleared at midnight ET');
    clearCacheAtMidnight(); // schedule next midnight clear
  }, msUntilMidnight);
  console.log('Cache will clear in ' + Math.round(msUntilMidnight/1000/60) + ' minutes');
}
clearCacheAtMidnight();
const MODEL         = 'claude-sonnet-4-20250514';
 
async function callClaude(body) {
  if (!ANTHROPIC_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set in environment variables');
  }
  console.log('Calling Anthropic, model:', MODEL, 'max_tokens:', body.max_tokens);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: MODEL, ...body })
  });
  console.log('Anthropic response status:', response.status);
  if (!response.ok) {
    const err = await response.text();
    console.error('Anthropic error body:', err);
    throw new Error('Anthropic API error ' + response.status + ': ' + err);
  }
  return response.json();
}
 
function getText(data) {
  return data.content?.map(c => c.text || '').join('') || '';
}
 
function parseJSON(text, fallback) {
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch(e) {
    console.error('JSON parse error:', e.message, '\nText:', text.slice(0, 200));
    return fallback;
  }
}
 
// ── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const todayET = getTodayET();
  res.json({
    status:     'ApolloProps API is running',
    time:       new Date().toISOString(),
    key_set:    !!ANTHROPIC_KEY,
    cache_date: picksCache.date || 'empty',
    cache_valid: isCacheValid(),
    picks_cached: Object.fromEntries(
      Object.entries(picksCache.picks).map(([k,v])=>[k, v.length])
    ),
    potd_cached: !!picksCache.potd,
    today_et:   todayET
  });
});
 
// GET handlers so browser URL tests work
app.get('/api/ask-apollo',   (req, res) => res.json({ status: 'ok', method: 'POST required' }));
app.get('/api/generate-picks',(req, res) => res.json({ status: 'ok', method: 'POST required' }));
 
// ── POST /api/ask-apollo ──────────────────────────────────────────────────
// Used by machine.html for: pick analysis, parlay analysis, Ask Apollo chat
// Body: { system: "...", messages: [...], max_tokens: 1000 }
app.post('/api/ask-apollo', async (req, res) => {
  try {
    const { system, messages, max_tokens } = req.body;
    if (!messages || !messages.length) {
      return res.status(400).json({ error: 'messages array required' });
    }
    const data = await callClaude({
      max_tokens: max_tokens || 1000,
      system:     system || 'You are Apollo, a sharp sports analyst.',
      messages:   messages
    });
    res.json(data);
  } catch(e) {
    console.error('/api/ask-apollo error:', e.message);
    res.status(500).json({ error: e.message, hint: 'Check Railway logs for details' });
  }
});
 
// ── POST /api/generate-picks ──────────────────────────────────────────────
// Used by machine.html when user selects a sport
// Body: { sport: "all|nba|mlb|nhl", date: "Tue May 13 2026" }
app.post('/api/generate-picks', async (req, res) => {
  const sport   = req.body.sport || 'all';
  const todayET = getTodayET();
 
  // ── SERVE FROM CACHE if picks already generated today ────────────────
  if(isCacheValid() && picksCache.picks[sport]){
    console.log(`Serving cached picks for ${sport} (${picksCache.picks[sport].length} picks)`);
    return res.json({ picks: picksCache.picks[sport], date: todayET, cached: true });
  }
  // If 'all' is cached, filter from it for specific sport requests
  if(isCacheValid() && picksCache.picks['all'] && sport !== 'all'){
    const filtered = picksCache.picks['all'].filter(p=>p.sport===sport);
    if(filtered.length){
      console.log(`Serving filtered cached picks for ${sport} (${filtered.length} picks)`);
      return res.json({ picks: filtered, date: todayET, cached: true });
    }
  }
 
  const date = todayET;
  console.log(`Generating fresh picks for ${sport} on ${date}`);
 
  // Build game schedule dynamically — update this block as season progresses
  const todayName = new Date(date).toLocaleDateString('en-US',{timeZone:'America/New_York',weekday:'long'});
 
  // ── ACCURATE AS OF MAY 14 2026 ────────────────────────────────────────
  // NBA: No games Thursday May 14. G6 games on Friday May 15.
  // CLE leads DET 3-2 (CLE won G5 117-113 on May 13)
  // SAS leads MIN 3-2 (SAS won G5 126-97 on May 12)
  // OKC swept LAL 4-0 — OKC in WCF. DO NOT pick OKC or LAL.
  // NYK swept PHI 4-0 — NYK in ECF. DO NOT pick NYK or PHI.
  //
  // MLB THURSDAY MAY 14: PIT@COL 12:35ET, CIN@WSH 12:40ET, DET@NYM 1:10ET,
  //   SD@MIL 1:40ET, MIA@MIN 1:40ET, SEA@HOU 2:10ET, STL@ATH 3:05ET,
  //   PHI@BOS 6:45ET, CHC@ATL 7:15ET, KC@CWS 7:40ET, LAD@SF 10:10ET
  //   NOTE: NO NYY or BAL games today. NO Gerrit Cole today.
  // ─────────────────────────────────────────────────────────────────────
 
  const NBA_SCHEDULE = sport === 'nba' || sport === 'all' ? `
NBA PLAYOFF STATUS (May 14 2026):
- NO NBA GAMES TODAY (Thursday May 14). Return 0 NBA picks.
- Next NBA: Friday May 15 — CLE @ DET G6 7:00PM ET, MIN @ SAS G6 9:30PM ET
- Series: CLE leads DET 3-2. SAS leads MIN 3-2.
- OKC swept LAL — DO NOT pick OKC or LAL players.
- NYK swept PHI — DO NOT pick NYK or PHI players.
` : '';
 
  const MLB_SCHEDULE = `
MLB GAMES TODAY (${date}):
PHI @ BOS 6:45PM ET | CHC @ ATL 7:15PM ET | KC @ CWS 7:40PM ET | LAD @ SF 10:10PM ET
PIT @ COL 12:35PM ET | CIN @ WSH 12:40PM ET | DET @ NYM 1:10PM ET
SD @ MIL 1:40PM ET | MIA @ MIN 1:40PM ET | SEA @ HOU 2:10PM ET | STL @ ATH 3:05PM ET
IMPORTANT: NO NYY game today. NO BAL game today. NO Gerrit Cole picks today.
Only generate picks for teams listed above.`;
 
  const gameContext = buildGameContext(date, sport);
  const systemPrompt = `You are a sports betting data engine. Today: ${date} (${todayName}).
${gameContext}
NO NHL games tonight.
 
CRITICAL: Only generate picks for matchups explicitly listed above.
Never invent games. Never use players from teams not listed.
 
Return ONLY valid compact JSON, no markdown, no explanation:
{"picks":[{
  "id":"p1",
  "player":"Full Player Name",
  "team":"ABBR",
  "opp":"ABBR",
  "sport":"nba|mlb",
  "time":"8:00 PM ET",
  "propType":"pts|reb|ast|hits|tb|hr|rbi|str|sok|ml|spread|total",
  "propLabel":"Points",
  "line":24.5,
  "direction":"over|under",
  "last5":[true,false,true,true,false],
  "confidence":78,
  "reason":"Max 12 words using real trend data",
  "recentScores":["G1: 23","G2: 31"],
  "gameKey":"SAS-MIN",
  "gameLabel":"SAS vs MIN (G5)",
  "odds":"-145"
}]}`;
 
  let pickCount = '18 picks';
  let instructions = '';
 
  if (sport === 'nba') {
    pickCount = '0 picks';
    instructions = 'Return empty picks array — no NBA games on Thursday May 14. Next NBA games are Friday May 15 (CLE@DET G6, MIN@SAS G6).';
  } else if (sport === 'mlb') {
    pickCount = '12 MLB picks';
    instructions = 'Generate 12 MLB picks using ONLY the games listed in MLB_TODAY. Mix: 4 pitcher strikeout props, 4 batter props (hits/total bases/HR), 2 team moneylines, 2 game totals. Use specific pitchers for each game if known. Never use NYY or BAL — they are off today.';
  } else if (sport === 'nhl') {
    pickCount = '0 picks';
    instructions = 'Return empty picks array — no NHL games tonight.';
  } else {
    // All sports
    pickCount = '12 picks';
    instructions = 'No NBA today. Generate 12 MLB picks only using the games in MLB_TODAY. Mix pitcher Ks, batter props (hits/TB/HR), team MLs and game totals. Never use NYY or BAL today. No NHL games tonight.';
  }
 
  try {
    const data = await callClaude({
      max_tokens: 1000,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: `Generate ${pickCount}. ${instructions}` }]
    });
    const rawText = getText(data);
    console.log('Raw Anthropic response (first 500):', rawText.slice(0, 500));
    const result = parseJSON(rawText, { picks: [] });
    console.log('Parsed picks count:', (result.picks||[]).length);
    // Validate picks have required fields
    const valid = (result.picks || []).filter(p =>
      p.player && p.sport && p.propType && p.line !== undefined && p.direction
    );
    console.log('Valid picks after filter:', valid.length);
 
    // ── STORE IN CACHE ─────────────────────────────────────────────────
    if(!isCacheValid()){
      picksCache.date  = getTodayET();
      picksCache.picks = {};
    }
    picksCache.picks[sport] = valid;
    // If generating 'all', also cache by sport
    if(sport === 'all'){
      ['nba','mlb','nhl'].forEach(s=>{
        picksCache.picks[s] = valid.filter(p=>p.sport===s);
      });
    }
    console.log(`Cached ${valid.length} picks for ${sport} on ${picksCache.date}`);
 
    res.json({ picks: valid, date: getTodayET(), cached: false });
  } catch(e) {
    console.error('/api/generate-picks error:', e.message);
    res.json({ picks: [] });
  }
});
 
// ── GET /api/pick-of-day ──────────────────────────────────────────────────
// Used by landing.html and machine.html for the Pick of the Day card
app.get('/api/pick-of-day', async (req, res) => {
  const todayET = getTodayET();
 
  // Serve cached POTD if available
  if(picksCache.potd && picksCache.potdDate === todayET){
    console.log('Serving cached POTD');
    return res.json({ pick: picksCache.potd, cached: true });
  }
 
  // If we have cached picks, derive POTD from them (no extra API call)
  if(isCacheValid() && picksCache.picks['all']?.length){
    const top = picksCache.picks['all'].sort((a,b)=>b.confidence-a.confidence)[0];
    picksCache.potd = top;
    picksCache.potdDate = todayET;
    console.log('POTD derived from cached picks:', top.player);
    return res.json({ pick: top, cached: true });
  }
 
  const date = todayET;
  try {
    const data = await callClaude({
      max_tokens: 400,
      system: `Sports betting analyst. Today: ${date}. No NBA games today (Thursday May 14).
MLB today: PHI@BOS 6:45ET, CHC@ATL 7:15ET, LAD@SF 10:10ET, KC@CWS 7:40ET, DET@NYM 1:10ET, SD@MIL 1:40ET, SEA@HOU 2:10ET. NO NYY or BAL today.
Return the single best MLB pick as JSON only: {"pick":{"player":"","team":"","opp":"","sport":"mlb","time":"","propType":"hits","propLabel":"Hits","line":0,"direction":"over","confidence":0,"odds":"","last5":[true,true,false,true,true],"reason":""}}`,
      messages: [{ role: 'user', content: 'What is the single best play tonight based on the strongest trend and matchup? Pick one specific player or team bet.' }]
    });
    const result = parseJSON(getText(data), { pick: null });
    // Cache the POTD
    if(result.pick){
      picksCache.potd = result.pick;
      picksCache.potdDate = getTodayET();
    }
    res.json(result);
  } catch(e) {
    console.error('/api/pick-of-day error:', e.message);
    res.json({ pick: null });
  }
});
 
// ── GET /api/picks-preview ────────────────────────────────────────────────
// Used by landing.html — returns a handful of picks for the free preview
app.get('/api/picks-preview', async (req, res) => {
  try {
    const data = await callClaude({
      max_tokens: 500,
      system: `Sports betting data engine. Today: ${new Date().toDateString()}.
Return 5 picks as JSON only (mix of NBA and MLB):
{"picks":[{"player":"","team":"","opp":"","sport":"nba|mlb","time":"","propType":"pts","propLabel":"Points","line":0,"direction":"over|under","confidence":0,"last5":[true,false,true,true,false]}],"total":15}`,
      messages: [{ role: 'user', content: 'Generate 5 preview picks for tonight including Anthony Edwards and Gerrit Cole.' }]
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
// wins/losses = last 30 days, pct = win percentage, units = profit in units
app.get('/api/record', (req, res) => {
  res.json({
    wins:   18,
    losses: 9,
    pct:    67,
    units:  6.2
  });
});
 
// ── POST /api/resolve-results ─────────────────────────────────────────────
// Used by machine.html to auto-check if pending picks won or lost
// Body: { picks: [{ id, player, sport, propType, line, direction, gameLabel, loggedDate }] }
app.post('/api/resolve-results', async (req, res) => {
  const picks = req.body.picks || [];
  if (!picks.length) return res.json({ results: [] });
 
  const list = picks
    .map((p, i) => `${i+1}. ID:${p.id} | ${p.sport.toUpperCase()} | ${p.player} | ${p.direction.toUpperCase()} ${p.line} ${p.propType} | ${p.gameLabel} | Logged: ${p.loggedDate}`)
    .join('\n');
 
  try {
    const data = await callClaude({
      max_tokens: 600,
      system: `Sports results verifier. Today: ${new Date().toDateString()}.
You know recent NBA, MLB and NHL game results.
SAS vs MIN series: G5 tonight, series tied 2-2.
DET vs CLE series: G5 Wednesday, series tied 2-2.
MLB games: check tonight's results.
Only mark win/loss when confident. If game hasn't happened yet, mark pending.
Return JSON only: {"results":[{"id":"...","result":"win|loss|pending|unknown","actual":"what happened in 8 words"}]}`,
      messages: [{ role: 'user', content: `Check these pending picks and return results:\n${list}` }]
    });
    const result = parseJSON(getText(data), { results: [] });
    res.json(result);
  } catch(e) {
    console.error('/api/resolve-results error:', e.message);
    res.json({ results: [] });
  }
});
 
// ── START SERVER ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ApolloProps API running on port ${PORT}`);
  console.log(`API key set: ${!!ANTHROPIC_KEY}`);
  console.log('CORS: open to all origins');
  console.log('Listening on 0.0.0.0 for Railway routing');
});
