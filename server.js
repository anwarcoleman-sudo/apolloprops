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
  console.log(`Cache will clear in ${Math.round(msUntilMidnight/1000/60)} minutes`);
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
 
  const systemPrompt = `You are a sports betting data engine. Today: ${date}.
 
TONIGHT'S GAMES:
NBA PLAYOFFS:
- SAS vs MIN Game 5 at 8PM ET (series tied 2-2, SAS won G1+G3, MIN won G2+G4)
- DET vs CLE Game 5 at 8PM ET Wednesday (series tied 2-2)
- OKC swept LAL 4-0 — DO NOT include OKC or LAL picks
- NYK swept PHI 4-0 — NYK in ECF, no picks
 
NBA TRENDS:
- Anthony Edwards: 36pts G4, series avg 28+, unstoppable
- Victor Wembanyama: only 4pts G4 due to foul trouble and ejection — big fade
- Dylan Harper (SAS): 24pts on 72% FG in G4 — hot hand
- De'Aaron Fox: 24pts but 34.8% FG — inefficient
- Donovan Mitchell: 23/31/35 rising each game at home
- Cade Cunningham: 23/25/27 — under his 30.6 avg all 3 games
- Jalen Duren: boards declining 12/10/4 — foul trouble
- Rudy Gobert: 13 rebounds G4
 
MLB TONIGHT:
NYY@BAL 6:35PM, PHI@BOS 6:45PM, LAA@CLE 6:10PM, TB@TOR 7:07PM,
DET@NYM 7:10PM, CHC@ATL 7:15PM, SD@MIL 7:40PM, SEA@HOU 8:10PM,
AZ@TEX 8:05PM, SF@LAD 10:10PM, STL@ATH 9:40PM
 
NO NHL GAMES TONIGHT.
 
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
    pickCount = '10 NBA picks';
    instructions = '5 player props from SAS vs MIN G5 (using real trends above), 2 player props from DET vs CLE (use Mitchell and Cunningham), 2 NBA team picks (ML or total for SAS vs MIN), 1 NBA team spread pick.';
  } else if (sport === 'mlb') {
    pickCount = '11 MLB picks';
    instructions = '6 MLB player props (mix of hits, total bases, HR, pitcher Ks from real games listed), 3 MLB team moneylines, 2 MLB game totals.';
  } else if (sport === 'nhl') {
    pickCount = '0 picks';
    instructions = 'Return empty picks array — no NHL games tonight.';
  } else {
    instructions = `5 NBA player props (SAS vs MIN + DET vs CLE players using real trends),
2 NBA team picks (SAS ML, SAS/MIN total),
6 MLB player props (real players from games listed),
3 MLB team picks (moneylines/totals),
2 bonus high-confidence picks of your choice from tonight.
Use ONLY players from teams playing tonight.`;
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
      system: `Sports betting analyst. Today: ${date}.
Tonight: SAS vs MIN G5 (Anthony Edwards 36pts G4, avg 28+ this series),
Wembanyama only 4pts G4 due to foul trouble.
MLB: Gerrit Cole starts for NYY (7.4 K/start avg).
Return the single best play tonight as JSON only:
{"pick":{"player":"","team":"","opp":"","sport":"nba","time":"","propType":"pts","propLabel":"Points","line":0,"direction":"over","confidence":0,"odds":"","last5":[true,true,false,true,true],"reason":"compelling reason in 15 words"}}`,
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
 
