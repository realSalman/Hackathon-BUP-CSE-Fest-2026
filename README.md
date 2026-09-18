# GridWise LLM — Smart Campus Energy Optimization

> BUP CSE Fest 2026 · Hackathon · Online Preliminary Round

An HTTP API + React dashboard that interprets natural-language operator notes using **Google Gemini / OpenRouter**, validates them through deterministic guardrails, and produces a cost-optimal 24-hour energy schedule via **linear programming (GLPK)**.

---

## Architecture

```
Operator Notes (natural language)
        │
        ▼
┌─────────────────────────────────┐
│  1. LLM Interpretation          │  ← Google Gemini / OpenRouter
│     Parse notes into structured │     (temperature=0, JSON mode)
│     directive objects            │
└───────────┬─────────────────────┘
            ▼
┌─────────────────────────────────┐
│  2. Deterministic Guardrails    │  ← guardrails.js
│     Validate directive_type,    │     No LLM output is trusted
│     hours, factor, reserves     │     until it passes hard checks
│     Demote invalid → no_op      │
└───────────┬─────────────────────┘
            ▼
┌─────────────────────────────────┐
│  3. LP Optimizer (GLPK)         │  ← optimizer.js
│     min Σ(grid × tariff)        │     Standard LP with all
│     s.t. energy balance,        │     directive constraints
│     battery, solar, directives  │     encoded as bounds
└───────────┬─────────────────────┘
            ▼
    Valid 24-hour Schedule JSON
```

### How the LLM is used

The LLM (Google Gemini or OpenRouter) is the **sole interpreter of operator notes**. Each note is sent to the model with a structured prompt containing all 6 supported directive types, time-window conventions, and the battery context. The model returns a JSON array of directive interpretations. This structured output is then passed to deterministic guardrails — the LLM output is **never trusted directly**.

### How guardrails work

`guardrails.js` validates every field of the LLM response:
- `directive_type` must be one of the 6 allowed types
- `hours` must be unique integers 0–23 in ascending order
- `factor` (solar_reduction) must be in [0, 1]
- `minimum_energy_kwh` must be ≥ 0 and ≤ battery capacity
- `max_grid_kwh` must be ≥ 0 and finite
- `no_op` must have `applies=false` and `structured_adjustment=null`
- Any invalid interpretation is safely demoted to `no_op`

### How the optimizer works

`optimizer.js` uses **GLPK (GNU Linear Programming Kit)** via `glpk.js` (WASM) to solve a standard LP:
- **Objective**: minimise `Σ(grid_kwh[h] × tariff[h])` for h=0..23
- **Variables**: `grid_h`, `solar_h`, `charge_h`, `discharge_h`, `E_h` per hour
- **Constraints**:
  - Energy balance: `grid + solar_used + discharge = demand + charge` (each hour)
  - Solar cap: `solar_used ≤ effective_solar` (after solar_reduction)
  - Battery state transitions: `E_h = E_{h-1} + charge - discharge`
  - Battery bounds: `min_reserve ≤ E_h ≤ capacity`
  - Charge/discharge rate limits
  - `no_charge_window` / `no_discharge_window` → variable fixed to 0
  - `max_grid_window` → upper bound on grid variable
  - `minimum_battery_reserve` → raised lower bound on E
  - End-of-day neutrality: `E_23 = initial_energy`

This guarantees the **mathematically optimal** cost for any feasible scenario.

## Project Structure

```
├── backend/
│   ├── server.js          # Express HTTP server (/health, /optimize-energy)
│   ├── llm.js             # Multi-provider LLM (OpenRouter + Gemini)
│   ├── guardrails.js      # Deterministic post-LLM validation
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

---

## Quick Start (Local Reproduction)

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
# Edit .env — set OPENROUTER_API_KEY and/or GEMINI_API_KEY (at least one required)
npm start
# → GridWise LLM server listening on 0.0.0.0:3000
```

### 2. Verify Health

```bash
curl http://localhost:3000/health
# → {"status":"ok"}
```

### 3. Run Public Sample Cases

```bash
cd backend
npm test
# Runs all 10 public sample cases from hackathon-Problem/
# Validates: directive interpretation, energy balance, battery state,
#            rate limits, end-of-day neutrality, and recalculated totals
```

### 4. Frontend (Optional Dashboard)

```bash
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

---

## Environment Variables

Create `backend/.env` from `backend/.env.example`. **Never commit `.env` — it is gitignored.**

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENROUTER_API_KEY` | ✅ (or Gemini) | — | OpenRouter API key (primary provider) |
| `GEMINI_API_KEY` | ✅ (or OpenRouter) | — | Google Gemini API key (fallback provider) |
| `OPENROUTER_MODEL` | ❌ | `google/gemini-2.5-flash` | OpenRouter model ID |
| `GEMINI_MODEL` | ❌ | `gemini-3.6-flash` | Gemini model ID |
| `PORT` | ❌ | `3000` | HTTP server port |

### Secret Handling

- API keys are loaded from environment variables via `dotenv`, never hard-coded.
- `.env` is listed in `.gitignore` and is **not** committed to the repository.
- `.env.example` shows the required variable names without real values.
- The Docker image does **not** bake in any secrets — pass them via `-e` flags at runtime.
- No keys, tokens, or stack traces are exposed in API responses.

---

## LLM Provider Chain

The system tries providers in order with automatic failover:
1. **OpenRouter** (primary) — better rate limits, wider model selection
2. **Google Gemini** (fallback) — direct Google API

Each provider retries up to 3× with exponential backoff on transient errors (503, 429, ECONNRESET).

If all providers fail, the service returns a safe fallback (all notes treated as `no_op`) rather than crashing.

---

## Endpoints

### GET /health
```bash
curl http://localhost:3000/health
# → {"status":"ok"}
```

### POST /optimize-energy

```bash
curl -X POST http://localhost:3000/optimize-energy \
  -H "Content-Type: application/json" \
  -d '{
    "scenario_id": "SAMPLE-01",
    "operator_notes": [
      "Facilities will wash the rooftop solar panels from noon until 2 PM. During cleaning, usable solar should be treated as roughly 25% of the forecast.",
      "The sports office moved next month'\''s registration deadline."
    ],
    "hours": [
      {"hour":0,"demand_kwh":90,"solar_kwh":0,"tariff_bdt_per_kwh":6},
      {"hour":1,"demand_kwh":85,"solar_kwh":0,"tariff_bdt_per_kwh":6},
      {"hour":2,"demand_kwh":80,"solar_kwh":0,"tariff_bdt_per_kwh":5},
      {"hour":3,"demand_kwh":80,"solar_kwh":0,"tariff_bdt_per_kwh":5},
      {"hour":4,"demand_kwh":85,"solar_kwh":0,"tariff_bdt_per_kwh":5},
      {"hour":5,"demand_kwh":95,"solar_kwh":0,"tariff_bdt_per_kwh":6},
      {"hour":6,"demand_kwh":110,"solar_kwh":5,"tariff_bdt_per_kwh":8},
      {"hour":7,"demand_kwh":130,"solar_kwh":20,"tariff_bdt_per_kwh":10},
      {"hour":8,"demand_kwh":150,"solar_kwh":50,"tariff_bdt_per_kwh":12},
      {"hour":9,"demand_kwh":165,"solar_kwh":90,"tariff_bdt_per_kwh":14},
      {"hour":10,"demand_kwh":175,"solar_kwh":130,"tariff_bdt_per_kwh":16},
      {"hour":11,"demand_kwh":180,"solar_kwh":160,"tariff_bdt_per_kwh":17},
      {"hour":12,"demand_kwh":185,"solar_kwh":180,"tariff_bdt_per_kwh":16},
      {"hour":13,"demand_kwh":180,"solar_kwh":170,"tariff_bdt_per_kwh":15},
      {"hour":14,"demand_kwh":170,"solar_kwh":140,"tariff_bdt_per_kwh":14},
      {"hour":15,"demand_kwh":165,"solar_kwh":90,"tariff_bdt_per_kwh":15},
      {"hour":16,"demand_kwh":170,"solar_kwh":45,"tariff_bdt_per_kwh":19},
      {"hour":17,"demand_kwh":185,"solar_kwh":10,"tariff_bdt_per_kwh":24},
      {"hour":18,"demand_kwh":205,"solar_kwh":0,"tariff_bdt_per_kwh":30},
      {"hour":19,"demand_kwh":215,"solar_kwh":0,"tariff_bdt_per_kwh":34},
      {"hour":20,"demand_kwh":205,"solar_kwh":0,"tariff_bdt_per_kwh":31},
      {"hour":21,"demand_kwh":175,"solar_kwh":0,"tariff_bdt_per_kwh":21},
      {"hour":22,"demand_kwh":135,"solar_kwh":0,"tariff_bdt_per_kwh":11},
      {"hour":23,"demand_kwh":105,"solar_kwh":0,"tariff_bdt_per_kwh":8}
    ],
    "battery": {
      "capacity_kwh": 220,
      "initial_energy_kwh": 110,
      "minimum_energy_kwh": 40,
      "max_charge_kwh_per_hour": 50,
      "max_discharge_kwh_per_hour": 50
    }
  }'
```

**Sample response** (abbreviated):
```json
{
  "scenario_id": "SAMPLE-01",
  "directive_interpretation": [
    {
      "note_index": 0,
      "applies": true,
      "directive_type": "solar_reduction",
      "structured_adjustment": {"hours": [12, 13], "factor": 0.25},
      "explanation": "Solar output reduced to 25% during panel cleaning."
    },
    {
      "note_index": 1,
      "applies": false,
      "directive_type": "no_op",
      "structured_adjustment": null,
      "explanation": "Registration deadline is unrelated to energy."
    }
  ],
  "hourly_plan": [ ... 24 entries ... ],
  "total_grid_kwh": 2752.25,
  "total_cost_bdt": 42130.25,
  "peak_grid_kwh": 215,
  "plan_summary": "Optimized 24-hour energy schedule applying solar_reduction directive(s) to minimize grid electricity cost."
}
```

---

## Docker Fallback

```bash
cd backend
docker build -t gridwise-llm .
docker run -d -p 3000:3000 \
  -e OPENROUTER_API_KEY=your-key \
  -e GEMINI_API_KEY=your-key \
  --name gridwise gridwise-llm

# Verify:
curl http://localhost:3000/health
# → {"status":"ok"}
```

The image exposes port 3000, binds to `0.0.0.0`, and contains no baked-in secrets.

---

## Dependencies

| Package | Purpose |
|---|---|
| `express` | HTTP server |
| `@google/generative-ai` | Google Gemini API client |
| `glpk.js` | GLPK LP solver (WASM) |
| `dotenv` | Environment variable loading |
| `react` + `vite` | Frontend dashboard |

**AI Tools**: Google Gemini (via OpenRouter and direct API) for operator-note interpretation. All external tools credited.

---

## Known Limitations

- **LLM dependency**: The service requires a live LLM API (OpenRouter or Gemini) for operator-note interpretation. If both providers are down, all notes are treated as `no_op` (safe fallback, but loses interpretation points).
- **Rate limits**: Free-tier Gemini may hit quota limits under repeated requests. OpenRouter is used as primary to mitigate this.
- **LP relaxation artifacts**: The LP solver may produce tiny simultaneous charge/discharge values due to floating-point relaxation. These are netted out in post-processing and remain within the 0.01 tolerance.
- **Single-note directives only**: Each operator note maps to exactly one directive. Notes containing multiple directives in a single sentence may not be fully captured (the problem spec guarantees one directive per note).
- **No caching**: Each request calls the LLM fresh. Repeated identical requests will incur API costs and latency.
