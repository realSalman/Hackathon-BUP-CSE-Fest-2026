require('dotenv').config();
const express = require('express');
const { interpretNotes } = require('./llm');
const { validateInterpretations } = require('./guardrails');
const { optimize } = require('./optimizer');

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS for frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── GET /health ────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ─── POST /optimize-energy ──────────────────────────────────────────────────────
app.post('/optimize-energy', async (req, res) => {
  try {
    // ── 1. Validate request schema ──────────────────────────────────────────
    const { scenario_id, operator_notes, hours, battery } = req.body || {};

    if (!scenario_id || !operator_notes || !hours || !battery) {
      return res.status(400).json({ error: 'Missing required top-level fields: scenario_id, operator_notes, hours, battery.' });
    }
    if (!Array.isArray(operator_notes) || operator_notes.length < 1 || operator_notes.length > 3) {
      return res.status(400).json({ error: 'operator_notes must be an array of 1-3 non-empty strings.' });
    }
    for (let i = 0; i < operator_notes.length; i++) {
      if (typeof operator_notes[i] !== 'string' || operator_notes[i].trim().length === 0) {
        return res.status(400).json({ error: `operator_notes[${i}] must be a non-empty string.` });
      }
    }
    if (!Array.isArray(hours) || hours.length !== 24) {
      return res.status(400).json({ error: 'hours must contain exactly 24 entries.' });
    }
    for (let i = 0; i < 24; i++) {
      const h = hours[i];
      if (h == null || typeof h.hour !== 'number' || typeof h.demand_kwh !== 'number' ||
        typeof h.solar_kwh !== 'number' || typeof h.tariff_bdt_per_kwh !== 'number') {
        return res.status(400).json({ error: `hours[${i}] missing or has invalid fields.` });
      }
    }
    const requiredBatteryFields = ['capacity_kwh', 'initial_energy_kwh', 'minimum_energy_kwh',
      'max_charge_kwh_per_hour', 'max_discharge_kwh_per_hour'];
    for (const f of requiredBatteryFields) {
      if (typeof battery[f] !== 'number') {
        return res.status(400).json({ error: `battery.${f} is missing or not a number.` });
      }
    }

    // ── 2. LLM Interpretation + 3. Guardrails (with retry) ────────────────
    let interpretations;
    const MAX_LLM_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_LLM_ATTEMPTS; attempt++) {
      let rawInterpretations;
      try {
        rawInterpretations = await interpretNotes(operator_notes, battery);
      } catch (llmErr) {
        console.error(`LLM interpretation error (attempt ${attempt + 1}):`, llmErr.message);
        if (attempt < MAX_LLM_ATTEMPTS - 1) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        // Final fallback: treat all notes as no_op
        rawInterpretations = operator_notes.map((_, i) => ({
          note_index: i,
          applies: false,
          directive_type: 'no_op',
          structured_adjustment: null,
          explanation: 'LLM interpretation failed; treated as no_op for safety.',
        }));
      }

      // Deterministic Guardrails
      interpretations = validateInterpretations(rawInterpretations, operator_notes, battery);

      // Check if guardrails demoted any interpretation (sign of LLM flake)
      const hasDemoted = interpretations.some(
        (interp, i) => interp.directive_type === 'no_op' &&
          interp.explanation && (
            interp.explanation.includes('Validation failed') ||
            interp.explanation.includes('could not be validated') ||
            interp.explanation.includes('Unsupported directive') ||
            interp.explanation.includes('Missing structured_adjustment') ||
            interp.explanation.includes('No valid hours')
          )
      );

      if (!hasDemoted || attempt >= MAX_LLM_ATTEMPTS - 1) {
        if (hasDemoted && attempt >= MAX_LLM_ATTEMPTS - 1) {
          console.warn(`Guardrail demotion persisted after ${MAX_LLM_ATTEMPTS} attempts.`);
        }
        break;
      }

      console.log(`Guardrails demoted an interpretation (attempt ${attempt + 1}), retrying LLM...`);
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }

    // ── 4. Optimize ─────────────────────────────────────────────────────────
    const result = await optimize(hours, battery, interpretations);

    // ── 5. Assemble response ────────────────────────────────────────────────
    return res.json({
      scenario_id,
      directive_interpretation: interpretations,
      hourly_plan: result.hourly_plan,
      total_grid_kwh: result.total_grid_kwh,
      total_cost_bdt: result.total_cost_bdt,
      peak_grid_kwh: result.peak_grid_kwh,
      plan_summary: result.plan_summary,
    });
  } catch (err) {
    console.error('Unhandled error in /optimize-energy:', err);
    return res.status(500).json({ error: 'Internal server error.', message: err.message, stack: err.stack });
  }
});

// ─── Catch-all for unknown routes ───────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// ─── Start server ───────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`GridWise LLM server listening on 0.0.0.0:${PORT}`);
  });
}

module.exports = app;
