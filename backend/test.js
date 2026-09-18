#!/usr/bin/env node
/**
 * test.js — Run all 10 public sample cases against the local server
 *
 * Usage:
 *   1. Start the server:  npm start
 *   2. In another terminal: node test.js
 *   3. Or test a remote server: BASE_URL=https://your-deploy.com node test.js
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TOLERANCE = 0.01;

async function main() {
  // ── Health check ──────────────────────────────────────────────────────────
  console.log(`\n🔍 Testing against ${BASE_URL}\n`);
  try {
    const hRes = await fetch(`${BASE_URL}/health`);
    const hBody = await hRes.json();
    if (hRes.status === 200 && hBody.status === 'ok') {
      console.log('✅  GET /health → {"status":"ok"}');
    } else {
      console.log(`❌  GET /health → ${hRes.status} ${JSON.stringify(hBody)}`);
      process.exit(1);
    }
  } catch (e) {
    console.log(`❌  GET /health failed: ${e.message}`);
    console.log('    Is the server running?  npm start');
    process.exit(1);
  }

  // ── Load sample cases ─────────────────────────────────────────────────────
  const casesPath = path.join(__dirname, '..', 'hackathon-Problem', 'BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json');
  const pack = JSON.parse(fs.readFileSync(casesPath, 'utf-8'));
  const cases = pack.cases;

  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    process.stdout.write(`\n── ${tc.id}: ${tc.label} ──\n`);

    let res, body;
    try {
      res = await fetch(`${BASE_URL}/optimize-energy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tc.input),
      });
      body = await res.json();
    } catch (e) {
      console.log(`  ❌ Request failed: ${e.message}`);
      failed++;
      continue;
    }

    if (res.status !== 200) {
      console.log(`  ❌ HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      failed++;
      continue;
    }

    const errors = [];
    const expected = tc.expected_output;

    // ── Check scenario_id ───────────────────────────────────────────────────
    if (body.scenario_id !== expected.scenario_id) {
      errors.push(`scenario_id: got "${body.scenario_id}", want "${expected.scenario_id}"`);
    }

    // ── Check directive_interpretation ───────────────────────────────────────
    if (!Array.isArray(body.directive_interpretation)) {
      errors.push('directive_interpretation is not an array');
    } else if (body.directive_interpretation.length !== expected.directive_interpretation.length) {
      errors.push(`directive_interpretation length: got ${body.directive_interpretation.length}, want ${expected.directive_interpretation.length}`);
    } else {
      for (let i = 0; i < expected.directive_interpretation.length; i++) {
        const got = body.directive_interpretation[i];
        const want = expected.directive_interpretation[i];

        if (got.note_index !== want.note_index) {
          errors.push(`interp[${i}].note_index: got ${got.note_index}, want ${want.note_index}`);
        }
        if (got.applies !== want.applies) {
          errors.push(`interp[${i}].applies: got ${got.applies}, want ${want.applies}`);
        }
        if (got.directive_type !== want.directive_type) {
          errors.push(`interp[${i}].directive_type: got "${got.directive_type}", want "${want.directive_type}"`);
        }

        // Check structured_adjustment
        if (want.structured_adjustment === null) {
          if (got.structured_adjustment !== null) {
            errors.push(`interp[${i}].structured_adjustment: should be null for no_op`);
          }
        } else if (got.structured_adjustment === null) {
          errors.push(`interp[${i}].structured_adjustment: got null, want an object`);
        } else {
          // Check hours
          const gotHours = JSON.stringify(got.structured_adjustment.hours);
          const wantHours = JSON.stringify(want.structured_adjustment.hours);
          if (gotHours !== wantHours) {
            errors.push(`interp[${i}].hours: got ${gotHours}, want ${wantHours}`);
          }
          // Check factor
          if (want.structured_adjustment.factor !== undefined) {
            if (Math.abs((got.structured_adjustment.factor || 0) - want.structured_adjustment.factor) > TOLERANCE) {
              errors.push(`interp[${i}].factor: got ${got.structured_adjustment.factor}, want ${want.structured_adjustment.factor}`);
            }
          }
          // Check minimum_energy_kwh
          if (want.structured_adjustment.minimum_energy_kwh !== undefined) {
            if (Math.abs((got.structured_adjustment.minimum_energy_kwh || 0) - want.structured_adjustment.minimum_energy_kwh) > TOLERANCE) {
              errors.push(`interp[${i}].minimum_energy_kwh: got ${got.structured_adjustment.minimum_energy_kwh}, want ${want.structured_adjustment.minimum_energy_kwh}`);
            }
          }
          // Check max_grid_kwh
          if (want.structured_adjustment.max_grid_kwh !== undefined) {
            if (Math.abs((got.structured_adjustment.max_grid_kwh || 0) - want.structured_adjustment.max_grid_kwh) > TOLERANCE) {
              errors.push(`interp[${i}].max_grid_kwh: got ${got.structured_adjustment.max_grid_kwh}, want ${want.structured_adjustment.max_grid_kwh}`);
            }
          }
        }
      }
    }

    // ── Check hourly_plan validity ──────────────────────────────────────────
    if (!Array.isArray(body.hourly_plan) || body.hourly_plan.length !== 24) {
      errors.push(`hourly_plan: expected 24 entries, got ${body.hourly_plan?.length}`);
    } else {
      // Replay energy constraints
      const battery = tc.input.battery;
      let prevE = battery.initial_energy_kwh;

      // Build effective solar from expected directives for validation
      const effSolar = tc.input.hours.map(h => h.solar_kwh);
      for (const interp of expected.directive_interpretation) {
        if (interp.applies && interp.directive_type === 'solar_reduction') {
          for (const h of interp.structured_adjustment.hours) {
            effSolar[h] = tc.input.hours[h].solar_kwh * interp.structured_adjustment.factor;
          }
        }
      }

      for (let h = 0; h < 24; h++) {
        const p = body.hourly_plan[h];
        const demand = tc.input.hours[h].demand_kwh;

        // Energy balance
        const chargeAmt = p.battery_action === 'charge' ? p.battery_kwh : 0;
        const dischargeAmt = p.battery_action === 'discharge' ? p.battery_kwh : 0;
        const lhs = p.grid_kwh + p.solar_used_kwh + dischargeAmt;
        const rhs = demand + chargeAmt;
        if (Math.abs(lhs - rhs) > TOLERANCE) {
          errors.push(`hour ${h}: energy balance failed (${lhs.toFixed(2)} ≠ ${rhs.toFixed(2)})`);
        }

        // Battery state
        const expectedE = prevE + chargeAmt - dischargeAmt;
        if (Math.abs(p.battery_energy_after_kwh - expectedE) > TOLERANCE) {
          errors.push(`hour ${h}: battery state mismatch (got ${p.battery_energy_after_kwh}, computed ${expectedE.toFixed(2)})`);
        }

        // Battery bounds
        if (p.battery_energy_after_kwh < battery.minimum_energy_kwh - TOLERANCE) {
          errors.push(`hour ${h}: battery below minimum (${p.battery_energy_after_kwh} < ${battery.minimum_energy_kwh})`);
        }
        if (p.battery_energy_after_kwh > battery.capacity_kwh + TOLERANCE) {
          errors.push(`hour ${h}: battery above capacity (${p.battery_energy_after_kwh} > ${battery.capacity_kwh})`);
        }

        // Rate limits
        if (chargeAmt > battery.max_charge_kwh_per_hour + TOLERANCE) {
          errors.push(`hour ${h}: charge exceeds limit (${chargeAmt} > ${battery.max_charge_kwh_per_hour})`);
        }
        if (dischargeAmt > battery.max_discharge_kwh_per_hour + TOLERANCE) {
          errors.push(`hour ${h}: discharge exceeds limit (${dischargeAmt} > ${battery.max_discharge_kwh_per_hour})`);
        }

        // Non-negative
        if (p.grid_kwh < -TOLERANCE) errors.push(`hour ${h}: negative grid_kwh`);
        if (p.solar_used_kwh < -TOLERANCE) errors.push(`hour ${h}: negative solar_used_kwh`);
        if (p.battery_kwh < -TOLERANCE) errors.push(`hour ${h}: negative battery_kwh`);

        // Idle must be 0
        if (p.battery_action === 'idle' && p.battery_kwh > TOLERANCE) {
          errors.push(`hour ${h}: idle with non-zero battery_kwh (${p.battery_kwh})`);
        }

        prevE = p.battery_energy_after_kwh;
      }

      // End-of-day
      if (Math.abs(prevE - battery.initial_energy_kwh) > TOLERANCE) {
        errors.push(`end-of-day: battery ${prevE.toFixed(2)} ≠ initial ${battery.initial_energy_kwh}`);
      }
    }

    // ── Check totals ────────────────────────────────────────────────────────
    if (body.hourly_plan && body.hourly_plan.length === 24) {
      const calcGrid = body.hourly_plan.reduce((s, p) => s + p.grid_kwh, 0);
      const calcCost = body.hourly_plan.reduce((s, p, i) => s + p.grid_kwh * tc.input.hours[i].tariff_bdt_per_kwh, 0);
      const calcPeak = Math.max(...body.hourly_plan.map(p => p.grid_kwh));

      if (Math.abs(body.total_grid_kwh - calcGrid) > TOLERANCE) {
        errors.push(`total_grid_kwh: reported ${body.total_grid_kwh}, recalc ${calcGrid.toFixed(2)}`);
      }
      if (Math.abs(body.total_cost_bdt - calcCost) > TOLERANCE) {
        errors.push(`total_cost_bdt: reported ${body.total_cost_bdt}, recalc ${calcCost.toFixed(2)}`);
      }
      if (Math.abs(body.peak_grid_kwh - calcPeak) > TOLERANCE) {
        errors.push(`peak_grid_kwh: reported ${body.peak_grid_kwh}, recalc ${calcPeak.toFixed(2)}`);
      }
    }

    // ── Verdict ─────────────────────────────────────────────────────────────
    if (errors.length === 0) {
      console.log(`  ✅ PASS — cost: ${body.total_cost_bdt} BDT (ref: ${expected.total_cost_bdt} BDT)`);
      passed++;
    } else {
      console.log(`  ❌ FAIL (${errors.length} issue(s)):`);
      errors.forEach(e => console.log(`     • ${e}`));
      failed++;
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ${passed}/${cases.length} passed, ${failed} failed`);
  console.log(`${'═'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
