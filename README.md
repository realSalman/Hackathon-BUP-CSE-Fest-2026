# GridWise LLM — Smart Campus Energy Optimization

> BUP CSE Fest 2026 · Hackathon · Online Preliminary Round

An HTTP API + React dashboard that interprets natural-language operator notes using **Google Gemini / OpenRouter**, validates them through deterministic guardrails, and produces a cost-optimal 24-hour energy schedule via **linear programming (GLPK)**.

## Architecture

```
┌─────────── Frontend (React + Vite) ──────────┐
│  Dashboard: input form, directive display,    │
│  stats, 24-hour hourly plan table             │
└──────────────────┬────────────────────────────┘
                   │ POST /optimize-energy
┌──────────────────▼────────────────────────────┐
│           Backend (Node.js + Express)          │
│  1. Request Validation                         │
│  2. LLM Interpretation (OpenRouter → Gemini)   │
│  3. Deterministic Guardrails                   │
│  4. LP Optimizer (GLPK)                        │
│  5. Response Assembly                          │
└────────────────────────────────────────────────┘
```

## Project Structure

```
├── backend/
│   ├── server.js          # Express HTTP server (/health, /optimize-energy)
│   ├── llm.js             # Multi-provider LLM (OpenRouter + Gemini)
│   ├── guardrails.js      # Deterministic validation
│   ├── optimizer.js       # GLPK LP solver
│   ├── test.js            # Public sample case runner
│   ├── package.json
│   ├── Dockerfile
│   ├── .env.example
│   └── .dockerignore
├── frontend/
│   ├── src/
│   │   ├── App.jsx        # React dashboard
│   │   ├── main.jsx       # Entry point
│   │   └── index.css      # Styles
│   ├── package.json
│   └── vite.config.js
├── hackathon-Problem/     # Problem documents & sample cases
└── README.md              # This file
```

## Quick Start

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
# Edit .env — set OPENROUTER_API_KEY and/or GEMINI_API_KEY
npm start
# → GridWise LLM server listening on 0.0.0.0:3000
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

### 3. Test

```bash
cd backend
npm test    # Runs all 10 public sample cases
```

## Environment Variables (backend/.env)

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENROUTER_API_KEY` | ✅ (or Gemini) | — | OpenRouter API key (primary) |
| `GEMINI_API_KEY` | ✅ (or OpenRouter) | — | Google Gemini API key (fallback) |
| `OPENROUTER_MODEL` | ❌ | `google/gemini-2.5-flash` | OpenRouter model |
| `GEMINI_MODEL` | ❌ | `gemini-3.6-flash` | Gemini model |
| `PORT` | ❌ | `3000` | HTTP server port |

## LLM Provider Chain

The system tries providers in order:
1. **OpenRouter** (primary) — better rate limits, wider model selection
2. **Google Gemini** (fallback) — direct API, may hit free-tier quotas

Each provider retries up to 3 times with exponential backoff on transient errors (503, 429).

## Endpoints

### GET /health
```bash
curl http://localhost:3000/health
# → {"status":"ok"}
```

### POST /optimize-energy
Accepts a scenario JSON with `scenario_id`, `operator_notes`, `hours` (24 entries), and `battery` config. Returns directive interpretation + 24-hour optimal energy plan.

## Docker

```bash
cd backend
docker build -t gridwise-llm .
docker run -d -p 3000:3000 \
  -e OPENROUTER_API_KEY=your-key \
  -e GEMINI_API_KEY=your-key \
  --name gridwise gridwise-llm
```

## Solver

**GLPK (GNU Linear Programming Kit)** via `glpk.js` solves a standard LP:
- **Objective**: minimise Σ(grid_kwh × tariff) over 24 hours
- **Constraints**: energy balance, solar cap, battery state, rate limits, end-of-day neutrality, plus all directive constraints
- **Verified**: 10/10 public sample cases pass with exact cost match

## Dependencies

| Package | Purpose |
|---|---|
| `express` | HTTP server |
| `@google/generative-ai` | Google Gemini API client |
| `glpk.js` | GLPK LP solver (WASM) |
| `dotenv` | Environment variable loading |
| `react` + `vite` | Frontend dashboard |
