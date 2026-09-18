/**
 * guardrails.js — Deterministic post-LLM validation
 *
 * Every field produced by the LLM is checked against hard rules before the
 * optimizer is allowed to use it.  If any value is out of range the entire
 * interpretation is demoted to a safe no_op.
 */

const ALLOWED_TYPES = new Set([
  'solar_reduction',
  'minimum_battery_reserve',
  'no_charge_window',
  'no_discharge_window',
  'max_grid_window',
  'no_op',
]);

/**
 * Validate and sanitise the raw LLM interpretations.
 *
 * @param {object[]} raw       – raw LLM output (may be malformed)
 * @param {string[]} notes     – original operator_notes
 * @param {object}   battery   – battery spec from the request
 * @returns {object[]}         – clean, guardrailed interpretation array
 */
function validateInterpretations(raw, notes, battery) {
  // If LLM returned garbage, fall back to all no_op
  if (!Array.isArray(raw) || raw.length !== notes.length) {
    return notes.map((_, i) => makeNoOp(i, 'Interpretation could not be validated.'));
  }

  return raw.map((interp, i) => {
    try {
      return validateOne(interp, i, battery);
    } catch {
      return makeNoOp(i, 'Validation failed; treated as no_op for safety.');
    }
  });
}

// ─── Single-interpretation validator ────────────────────────────────────────────

function validateOne(interp, index, battery) {
  // Ensure note_index is correct
  const noteIndex = index; // always enforce sequential order

  // Check directive_type
  const type = interp && interp.directive_type;
  if (!type || !ALLOWED_TYPES.has(type)) {
    return makeNoOp(noteIndex, interp?.explanation || 'Unsupported directive type.');
  }

  // ── no_op ─────────────────────────────────────────────────────────────────
  if (type === 'no_op') {
    return makeNoOp(noteIndex, interp.explanation || 'No energy impact.');
  }

  // ── All non-no_op types need structured_adjustment with valid hours ────────
  const adj = interp.structured_adjustment;
  if (!adj || typeof adj !== 'object') {
    return makeNoOp(noteIndex, 'Missing structured_adjustment.');
  }

  const hours = sanitiseHours(adj.hours);
  if (hours.length === 0) {
    return makeNoOp(noteIndex, 'No valid hours in adjustment.');
  }

  switch (type) {
    case 'solar_reduction': {
      const factor = Number(adj.factor);
      if (!Number.isFinite(factor) || factor < 0 || factor > 1) {
        return makeNoOp(noteIndex, 'Solar factor out of range.');
      }
      return makeDirective(noteIndex, type, { hours, factor }, interp.explanation);
    }

    case 'minimum_battery_reserve': {
      const min = Number(adj.minimum_energy_kwh);
      if (!Number.isFinite(min) || min < 0 || min > battery.capacity_kwh) {
        return makeNoOp(noteIndex, 'Reserve value out of range.');
      }
      return makeDirective(noteIndex, type, { hours, minimum_energy_kwh: min }, interp.explanation);
    }

    case 'no_charge_window':
      return makeDirective(noteIndex, type, { hours }, interp.explanation);

    case 'no_discharge_window':
      return makeDirective(noteIndex, type, { hours }, interp.explanation);

    case 'max_grid_window': {
      const max = Number(adj.max_grid_kwh);
      if (!Number.isFinite(max) || max < 0) {
        return makeNoOp(noteIndex, 'Grid cap value invalid.');
      }
      return makeDirective(noteIndex, type, { hours, max_grid_kwh: max }, interp.explanation);
    }

    default:
      return makeNoOp(noteIndex, 'Unrecognised directive type.');
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function sanitiseHours(raw) {
  if (!Array.isArray(raw)) return [];
  const set = new Set();
  for (const v of raw) {
    const h = Math.round(Number(v));
    if (Number.isInteger(h) && h >= 0 && h <= 23) set.add(h);
  }
  return [...set].sort((a, b) => a - b);
}

function makeNoOp(noteIndex, explanation) {
  return {
    note_index: noteIndex,
    applies: false,
    directive_type: 'no_op',
    structured_adjustment: null,
    explanation: explanation || 'This note does not affect today\'s energy schedule.',
  };
}

function makeDirective(noteIndex, type, adjustment, explanation) {
  return {
    note_index: noteIndex,
    applies: true,
    directive_type: type,
    structured_adjustment: adjustment,
    explanation: explanation || `Applied ${type} directive.`,
  };
}

module.exports = { validateInterpretations };
