/**
 * optimizer.js — Linear-programming energy scheduler using GLPK
 *
 * Formulates a standard LP:
 *   minimise  Σ grid[h] × tariff[h]
 *   subject to energy balance, solar cap, battery state/bounds/rate limits,
 *              end-of-day neutrality, and all operator directives.
 *
 * Variables per hour h (0-23):
 *   grid_h      ≥ 0    grid energy purchased
 *   solar_h     ≥ 0    solar energy used  (≤ effective solar)
 *   charge_h    ≥ 0    energy flowing INTO battery
 *   discharge_h ≥ 0    energy flowing OUT of battery
 *   E_h                battery state-of-energy after hour h
 */

let _glpk = null;

async function getGlpk() {
  if (_glpk) return _glpk;
  const factory = require('glpk.js');
  const instance = factory();
  _glpk = (instance && typeof instance.then === 'function') ? await instance : instance;
  return _glpk;
}

/**
 * Build and solve the 24-hour LP.
 *
 * @param {object[]} hours            – 24 hourly entries from the request
 * @param {object}   battery          – battery spec
 * @param {object[]} interpretations  – guardrailed directive interpretations
 * @returns {object}                  – { hourly_plan, total_grid_kwh, total_cost_bdt, peak_grid_kwh, plan_summary }
 */
async function optimize(hours, battery, interpretations) {
  const glpk = await getGlpk();

  // ── 1. Compute effective solar after solar_reduction ──────────────────────
  const effectiveSolar = hours.map(h => h.solar_kwh);
  for (const interp of interpretations) {
    if (interp.applies && interp.directive_type === 'solar_reduction') {
      for (const h of interp.structured_adjustment.hours) {
        effectiveSolar[h] = hours[h].solar_kwh * interp.structured_adjustment.factor;
      }
    }
  }

  // ── 2. Collect directive constraints ──────────────────────────────────────
  const noChargeHours = new Set();
  const noDischargeHours = new Set();
  const minReserveByHour = {};   // h → kWh
  const maxGridByHour = {};      // h → kWh

  for (const interp of interpretations) {
    if (!interp.applies) continue;
    const adj = interp.structured_adjustment;
    switch (interp.directive_type) {
      case 'no_charge_window':
        adj.hours.forEach(h => noChargeHours.add(h));
        break;
      case 'no_discharge_window':
        adj.hours.forEach(h => noDischargeHours.add(h));
        break;
      case 'minimum_battery_reserve':
        for (const h of adj.hours) {
          minReserveByHour[h] = Math.max(minReserveByHour[h] || 0, adj.minimum_energy_kwh);
        }
        break;
      case 'max_grid_window':
        for (const h of adj.hours) {
          maxGridByHour[h] = maxGridByHour[h] === undefined
            ? adj.max_grid_kwh
            : Math.min(maxGridByHour[h], adj.max_grid_kwh);
        }
        break;
    }
  }

  // ── 3. Build LP ──────────────────────────────────────────────────────────
  const objectiveVars = [];
  const constraints = [];
  const bounds = [];

  for (let h = 0; h < 24; h++) {
    const demand = hours[h].demand_kwh;
    const tariff = hours[h].tariff_bdt_per_kwh;
    const solar  = effectiveSolar[h];

    // Objective: minimise grid cost
    objectiveVars.push({ name: `grid_${h}`, coef: tariff });

    // Energy balance:  grid + solar_used + discharge − charge = demand
    constraints.push({
      name: `bal_${h}`,
      vars: [
        { name: `grid_${h}`,      coef:  1 },
        { name: `solar_${h}`,     coef:  1 },
        { name: `discharge_${h}`, coef:  1 },
        { name: `charge_${h}`,    coef: -1 },
      ],
      bnds: { type: glpk.GLP_FX, lb: demand, ub: demand },
    });

    // Battery state transition:
    //   h=0:  E_0 − charge_0 + discharge_0 = initial_energy
    //   h>0:  E_h − E_{h−1} − charge_h + discharge_h = 0
    if (h === 0) {
      constraints.push({
        name: `bat_${h}`,
        vars: [
          { name: `E_${h}`,         coef:  1 },
          { name: `charge_${h}`,    coef: -1 },
          { name: `discharge_${h}`, coef:  1 },
        ],
        bnds: { type: glpk.GLP_FX, lb: battery.initial_energy_kwh, ub: battery.initial_energy_kwh },
      });
    } else {
      constraints.push({
        name: `bat_${h}`,
        vars: [
          { name: `E_${h}`,         coef:  1 },
          { name: `E_${h - 1}`,     coef: -1 },
          { name: `charge_${h}`,    coef: -1 },
          { name: `discharge_${h}`, coef:  1 },
        ],
        bnds: { type: glpk.GLP_FX, lb: 0, ub: 0 },
      });
    }

    // ── Variable bounds ───────────────────────────────────────────────────
    // grid
    const gridUb = maxGridByHour[h] !== undefined ? maxGridByHour[h] : 1e9;
    bounds.push({ name: `grid_${h}`, type: glpk.GLP_DB, lb: 0, ub: gridUb });

    // solar used
    bounds.push({ name: `solar_${h}`, type: glpk.GLP_DB, lb: 0, ub: solar });

    // charge
    const chargeUb = noChargeHours.has(h) ? 0 : battery.max_charge_kwh_per_hour;
    if (chargeUb === 0) {
      bounds.push({ name: `charge_${h}`, type: glpk.GLP_FX, lb: 0, ub: 0 });
    } else {
      bounds.push({ name: `charge_${h}`, type: glpk.GLP_DB, lb: 0, ub: chargeUb });
    }

    // discharge
    const dischargeUb = noDischargeHours.has(h) ? 0 : battery.max_discharge_kwh_per_hour;
    if (dischargeUb === 0) {
      bounds.push({ name: `discharge_${h}`, type: glpk.GLP_FX, lb: 0, ub: 0 });
    } else {
      bounds.push({ name: `discharge_${h}`, type: glpk.GLP_DB, lb: 0, ub: dischargeUb });
    }

    // battery energy state
    const eLb = Math.max(battery.minimum_energy_kwh, minReserveByHour[h] || 0);
    bounds.push({ name: `E_${h}`, type: glpk.GLP_DB, lb: eLb, ub: battery.capacity_kwh });
  }

  // End-of-day neutrality:  E_23 = initial_energy
  constraints.push({
    name: 'eod',
    vars: [{ name: 'E_23', coef: 1 }],
    bnds: { type: glpk.GLP_FX, lb: battery.initial_energy_kwh, ub: battery.initial_energy_kwh },
  });

  // ── 4. Solve ─────────────────────────────────────────────────────────────
  const lp = {
    name: 'GridWise',
    objective: {
      direction: glpk.GLP_MIN,
      name: 'total_cost',
      vars: objectiveVars,
    },
    subjectTo: constraints,
    bounds,
  };

  const res = glpk.solve(lp, { msglev: glpk.GLP_MSG_OFF, presol: true });

  if (res.result.status !== glpk.GLP_OPT) {
    throw new Error(`LP solver status ${res.result.status} — problem may be infeasible.`);
  }

  const vars = res.result.vars;

  // ── 5. Extract hourly plan ────────────────────────────────────────────────
  const hourlyPlan = [];
  let totalGridKwh  = 0;
  let totalCostBdt  = 0;
  let peakGridKwh   = 0;

  for (let h = 0; h < 24; h++) {
    const rawGrid      = vars[`grid_${h}`];
    const rawSolar     = vars[`solar_${h}`];
    const rawCharge    = vars[`charge_${h}`];
    const rawDischarge = vars[`discharge_${h}`];
    const eAfter       = r(vars[`E_${h}`]);

    // Net out simultaneous charge/discharge (LP relaxation artefact)
    let netCharge    = rawCharge - rawDischarge;  // positive = net charge, negative = net discharge
    let gridKwh      = r(rawGrid);
    let solarUsedKwh = r(rawSolar);

    let batteryAction, batteryKwh;
    if (netCharge > 0.005) {
      batteryAction = 'charge';
      batteryKwh    = r(netCharge);
    } else if (netCharge < -0.005) {
      batteryAction = 'discharge';
      batteryKwh    = r(-netCharge);
    } else {
      batteryAction = 'idle';
      batteryKwh    = 0;
    }

    hourlyPlan.push({
      hour: h,
      grid_kwh: gridKwh,
      solar_used_kwh: solarUsedKwh,
      battery_action: batteryAction,
      battery_kwh: batteryKwh,
      battery_energy_after_kwh: eAfter,
    });

    totalGridKwh += gridKwh;
    totalCostBdt += gridKwh * hours[h].tariff_bdt_per_kwh;
    peakGridKwh   = Math.max(peakGridKwh, gridKwh);
  }

  // ── 6. Summary ────────────────────────────────────────────────────────────
  const applied = interpretations.filter(i => i.applies).map(i => i.directive_type);
  let summary = 'Optimized 24-hour energy schedule';
  if (applied.length > 0) {
    summary += ` applying ${applied.join(', ')} directive(s)`;
  }
  summary += ` to minimize grid electricity cost.`;
  summary += ` Total cost: ${r(totalCostBdt)} BDT, total grid: ${r(totalGridKwh)} kWh, peak grid hour: ${r(peakGridKwh)} kWh.`;

  return {
    hourly_plan:    hourlyPlan,
    total_grid_kwh: r(totalGridKwh),
    total_cost_bdt: r(totalCostBdt),
    peak_grid_kwh:  r(peakGridKwh),
    plan_summary:   summary,
  };
}

/** Round to 2 decimal places, clamp tiny negatives to 0. */
function r(v) {
  const n = Math.round(v * 100) / 100;
  return n < 0 && n > -0.01 ? 0 : n;
}

module.exports = { optimize };
