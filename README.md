# ApolloProps API

Backend server for ApolloProps. Holds the Anthropic API key securely server-side.

## Deploy to Railway (5 minutes)

1. Push this folder to a new GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub repo
3. Select this repo
4. Go to Variables tab → add:
   - ANTHROPIC_API_KEY = sk-ant-yourkey
   - ALLOWED_ORIGINS = https://apolloprops.com,https://www.apolloprops.com
5. Go to Settings → Networking → Generate Domain
6. Copy the domain (e.g. apolloprops-api.up.railway.app)
7. Paste that domain into machine.html and landing.html everywhere it says:
   fetch('/api/  →  fetch('https://apolloprops-api.up.railway.app/api/

## Local testing

  npm install
  cp .env.example .env
  # edit .env and add your real API key
  node server.js
  # test: curl http://localhost:3000/

## Endpoints

  POST /api/ask-apollo        AI chat and pick analysis
  POST /api/generate-picks    Daily picks generation
  GET  /api/pick-of-day       Pick of the Day card
  GET  /api/picks-preview     Landing page free preview
  GET  /api/record            Win/loss record stats
  POST /api/resolve-results   Auto-resolve pending picks
