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
// Open CORS — allows any domain to call this API
// This is intentional: the frontend is public HTML on HostGator
// Security comes from the API key being server-side only
app.use(cors());
 
// ── ANTHROPIC HELPER ──────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL         = 'claude-sonnet-4-20250514';
 
async function callClaude(body) {
  if (!ANTHROPIC_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set in environment variables');
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: MODEL, ...body })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
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
  res.json({
    status:  'ApolloProps API is running',
    time:    new Date().toISOString(),
    key_set: !!ANTHROPIC_KEY
  });
});
 
// ── POST /api/ask-apollo ──────────────────────────────────────────────────
// Used by machine.html for: pick analysis, parlay analysis, Ask Apollo chat
// Body: { system: "...", messages: [...], max_tokens: 1000 }
app.post('/api/ask-apollo', async (req, res) => {
  try {
    const { system, messages, max_tokens } = req.body;
    const data = await callClaude({
      max_tokens: max_tokens || 1000,
      system:     system,
      messages:   messages
    });
    res.json(data);
  } catch(e) {
    console.error('/api/ask-apollo error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
 
// ── POST /api/generate-picks ──────────────────────────────────────────────
// Used by machine.html when user selects a sport
// Body: { sport: "all|nba|mlb|nhl", date: "Tue May 13 2026" }
app.post('/api/generate-picks', async (req, res) => {
  const sport = req.body.sport || 'all';
  const date  = req.body.date  || new Date().toDateString();
 
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
    const result = parseJSON(getText(data), { picks: [] });
    // Validate picks have required fields
    const valid = (result.picks || []).filter(p =>
      p.player && p.sport && p.propType && p.line !== undefined && p.direction
    );
    res.json({ picks: valid });
  } catch(e) {
    console.error('/api/generate-picks error:', e.message);
    res.json({ picks: [] });
  }
});
 
// ── GET /api/pick-of-day ──────────────────────────────────────────────────
// Used by landing.html and machine.html for the Pick of the Day card
app.get('/api/pick-of-day', async (req, res) => {
  const date = new Date().toDateString();
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
// Used by landing.html for the win/loss record section
// UPDATE THESE NUMBERS MANUALLY as your real record builds
app.get('/api/record', (req, res) => {
  // TODO: Replace with your actual verified record once you have 30 days of picks
  // Connect to a database if you want this to update automatically
  res.json({
    wins:   0,
    losses: 0,
    pct:    0,
    units:  0.0,
    note:   'Record tracking starts from launch'
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
app.listen(PORT, () => {
  console.log(`ApolloProps API running on port ${PORT}`);
  console.log(`API key set: ${!!ANTHROPIC_KEY}`);
  console.log(`Allowed origins: ${ALLOWED.join(', ')}`);
});
