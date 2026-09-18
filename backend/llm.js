/**
 * llm.js — Multi-provider LLM operator-note interpreter
 *
 * Supports:
 *   1. OpenRouter (primary — no harsh free-tier rate limits)
 *   2. Google Gemini (fallback)
 *
 * Sends operator notes + battery context to the LLM and returns structured
 * JSON interpretations.  Output is validated by guardrails.js before the
 * optimizer sees it.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─── Provider configuration ────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// ─── In-memory response cache ──────────────────────────────────────────────────
// Keyed on a hash of (operatorNotes + battery). Avoids redundant LLM calls for
// repeated identical requests, drastically reducing p95 latency.
const _cache = new Map();
const CACHE_MAX = 200;

function cacheKey(operatorNotes, battery) {
  return JSON.stringify({ n: operatorNotes, b: battery });
}

function cacheGet(key) {
  if (!_cache.has(key)) return null;
  // Move to end (LRU)
  const val = _cache.get(key);
  _cache.delete(key);
  _cache.set(key, val);
  return val;
}

function cacheSet(key, val) {
  if (_cache.size >= CACHE_MAX) {
    // Evict oldest
    _cache.delete(_cache.keys().next().value);
  }
  _cache.set(key, val);
}

// ─── Per-call timeout wrapper ──────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ─── Provider: OpenRouter ──────────────────────────────────────────────────────

async function callOpenRouter(prompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://gridwise-llm.local',
      'X-Title': 'GridWise LLM',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: 'You are a precise JSON-only energy directive classifier. Return ONLY a valid JSON array. No thinking, no explanation, no markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─── Provider: Google Gemini ───────────────────────────────────────────────────

let genAI;
function getGenAI() {
  if (!genAI) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  }
  return genAI;
}

async function callGemini(prompt) {
  const ai = getGenAI();
  const model = ai.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    },
  });

  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

// ─── Core interpretation function ──────────────────────────────────────────────

/**
 * Interpret 1-3 operator notes via LLM.
 * Tries OpenRouter first, then Gemini, with retries on transient errors.
 *
 * @param {string[]} operatorNotes  – 1-3 natural-language notes
 * @param {object}   battery        – battery spec from the request
 * @returns {object[]}              – raw interpretation array (to be guardrailed)
 */
async function interpretNotes(operatorNotes, battery) {
  // ── Cache check ────────────────────────────────────────────────────────────
  const key = cacheKey(operatorNotes, battery);
  const cached = cacheGet(key);
  if (cached) {
    console.log('  [Cache] HIT — skipping LLM call');
    return cached;
  }

  const prompt = buildPrompt(operatorNotes, battery);

  // Build provider list: Gemini first (lower cold-start latency), OpenRouter as fallback
  const providers = [];
  if (GEMINI_API_KEY)     providers.push({ name: 'Gemini',     fn: () => withTimeout(callGemini(prompt), 25000, 'Gemini') });
  if (OPENROUTER_API_KEY) providers.push({ name: 'OpenRouter', fn: () => withTimeout(callOpenRouter(prompt), 25000, 'OpenRouter') });

  if (providers.length === 0) {
    throw new Error('No LLM API keys configured. Set OPENROUTER_API_KEY or GEMINI_API_KEY.');
  }

  let lastError;

  for (const provider of providers) {
    // Retry each provider up to 2 times (reduced to stay within 30s budget)
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const text = await provider.fn();
        console.log(`  [${provider.name}] raw response (${text.length} chars): ${text.slice(0, 200)}...`);
        const result = parseResponse(text);
        // Store in cache for next time
        cacheSet(key, result);
        return result;
      } catch (err) {
        lastError = err;
        const msg = err.message || '';
        const isTransient = msg.includes('503') || msg.includes('429') || msg.includes('overloaded') ||
          msg.includes('ECONNRESET') || msg.includes('fetch failed') || msg.includes('rate');

        if (isTransient && attempt < MAX_RETRIES - 1) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt), 5000);
          console.log(`  [${provider.name}] retry ${attempt + 1}/${MAX_RETRIES} after ${delayMs}ms...`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }

        console.log(`  [${provider.name}] failed: ${msg.slice(0, 150)}`);
        break; // move to next provider
      }
    }
  }

  throw lastError;
}

// ─── Response parser ────────────────────────────────────────────────────────────

function parseResponse(text) {
  let json = text.trim();

  // Strip accidental code fences
  if (json.includes('```')) {
    const match = json.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) json = match[1].trim();
    else json = json.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  }

  // Try to extract a JSON array from the text (handles thinking models that emit text before JSON)
  // Look for the outermost [...] in the string
  const arrStart = json.indexOf('[');
  const arrEnd = json.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    const candidate = json.slice(arrStart, arrEnd + 1);
    try {
      const arr = JSON.parse(candidate);
      if (Array.isArray(arr)) return arr;
    } catch { /* fall through */ }
  }

  // Try to extract a JSON object { ... } (wrapper like { interpretations: [...] })
  const objStart = json.indexOf('{');
  const objEnd = json.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    const candidate = json.slice(objStart, objEnd + 1);
    try {
      const obj = JSON.parse(candidate);
      if (Array.isArray(obj)) return obj;
      if (obj.interpretations) return obj.interpretations;
      if (obj.directive_interpretation) return obj.directive_interpretation;
      if (obj.note_index !== undefined) return [obj];
    } catch { /* fall through */ }
  }

  // Last resort: plain JSON.parse
  const parsed = JSON.parse(json);
  if (Array.isArray(parsed)) return parsed;
  if (parsed.interpretations) return parsed.interpretations;
  if (parsed.directive_interpretation) return parsed.directive_interpretation;
  if (parsed.note_index !== undefined) return [parsed];

  throw new Error('LLM response is not a recognisable interpretation array');
}

// ─── Prompt builder ─────────────────────────────────────────────────────────────

function buildPrompt(notes, battery) {
  return `You are an energy-system operator assistant for a university campus.
Your ONLY job is to classify each operator note into exactly one supported directive type and extract the structured parameters.

## Battery context for this scenario
- capacity_kwh: ${battery.capacity_kwh}
- initial_energy_kwh: ${battery.initial_energy_kwh}
- minimum_energy_kwh: ${battery.minimum_energy_kwh}
- max_charge_kwh_per_hour: ${battery.max_charge_kwh_per_hour}
- max_discharge_kwh_per_hour: ${battery.max_discharge_kwh_per_hour}

## Supported directive types

1. **solar_reduction** — Usable solar output is reduced during specific hours.
   structured_adjustment: {"hours": [int, ...], "factor": number}
   - "factor" is the FRACTION OF SOLAR THAT REMAINS USABLE (not the fraction removed).
   - "80% reduction" means only 20% remains → factor = 0.20
   - "drops to about 25%" → factor = 0.25
   - "roughly one-fifth of normal" → factor = 0.20
   - "half of the forecast" → factor = 0.50

2. **minimum_battery_reserve** — Battery energy must stay at or above a level during specific hours.
   structured_adjustment: {"hours": [int, ...], "minimum_energy_kwh": number}
   - If stated as a percentage of capacity, compute the absolute kWh value.
   - Example: "50% of capacity" with capacity ${battery.capacity_kwh} → minimum_energy_kwh = ${battery.capacity_kwh * 0.5}

3. **no_charge_window** — Battery charging is forbidden during specific hours.
   structured_adjustment: {"hours": [int, ...]}
   - Triggered by: charger isolated, charging disabled, charger maintenance, charging circuit unavailable, etc.

4. **no_discharge_window** — Battery discharging is forbidden during specific hours.
   structured_adjustment: {"hours": [int, ...]}
   - Triggered by: must not discharge, discharge disabled, protection testing, relay testing, etc.

5. **max_grid_window** — Grid import is capped at a maximum kWh per hour during specific hours.
   structured_adjustment: {"hours": [int, ...], "max_grid_kwh": number}
   - Triggered by: feeder limit, transformer limit, grid cap, substation constraint, etc.

6. **no_op** — The note does NOT affect the 24-hour energy schedule at all.
   structured_adjustment: null
   - Triggered by: cafeteria, sports, library, seminars, bookings, administrative matters, club notices, registration deadlines, book returns, room bookings, or anything unrelated to solar/battery/grid/energy.

## Time-window convention (CRITICAL)
- Windows are START-INCLUSIVE, END-EXCLUSIVE.
- "from 1 PM to 3 PM" → hours [13, 14]     (NOT [13, 14, 15])
- "from 6 PM until 9 PM" → hours [18, 19, 20]
- "from 6 PM until 10 PM" → hours [18, 19, 20, 21]
- "from 2 AM until 5 AM" → hours [2, 3, 4]
- "from noon until 2 PM" → hours [12, 13]
- "from 11 AM to 2 PM" → hours [11, 12, 13]
- "between 2 PM and 4 PM" → hours [14, 15]
- "between 13:00 and 15:00" → hours [13, 14]
- "during the 1-3 PM window" → hours [13, 14]
- Hours must be unique integers 0-23 in ascending order.

## Notes to interpret
${notes.map((n, i) => `[Note ${i}]: "${n}"`).join('\n')}

## Required output
Return a JSON array of exactly ${notes.length} objects, one per note IN ORDER.
Each object:
{
  "note_index": <int 0-based>,
  "applies": <boolean — false ONLY for no_op, true for all others>,
  "directive_type": "<one of the 6 types>",
  "structured_adjustment": <the exact object for that type, or null for no_op>,
  "explanation": "<1-2 sentence explanation>"
}

Return ONLY the JSON array. No markdown, no code fences, no surrounding text.`;
}

module.exports = { interpretNotes };
