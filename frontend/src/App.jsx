import { useState, useEffect } from 'react'
import './index.css'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000'

// ─── Sample cases (embedded for quick testing) ──────────────────────────────────
const SAMPLES = [
  {
    id: 'SAMPLE-01', label: 'Solar cleaning + distractor',
    input: {
      scenario_id: 'SAMPLE-01',
      operator_notes: [
        'Facilities will wash the rooftop solar panels from noon until 2 PM. During cleaning, usable solar should be treated as roughly 25% of the forecast.',
        'The sports office moved next month\'s registration deadline.'
      ],
      hours: Array.from({ length: 24 }, (_, h) => ({
        hour: h,
        demand_kwh: [90,85,80,80,85,95,110,130,150,165,175,180,185,180,170,165,170,185,205,215,205,175,135,105][h],
        solar_kwh: [0,0,0,0,0,0,5,20,50,90,130,160,180,170,140,90,45,10,0,0,0,0,0,0][h],
        tariff_bdt_per_kwh: [6,6,5,5,5,6,8,10,12,14,16,17,16,15,14,15,19,24,30,34,31,21,11,8][h]
      })),
      battery: { capacity_kwh: 220, initial_energy_kwh: 110, minimum_energy_kwh: 40, max_charge_kwh_per_hour: 50, max_discharge_kwh_per_hour: 50 }
    }
  },
  {
    id: 'SAMPLE-02', label: 'Battery charging maintenance',
    input: {
      scenario_id: 'SAMPLE-02',
      operator_notes: ['The battery charger unit will be isolated for preventive maintenance from 2 AM until 5 AM.'],
      hours: Array.from({ length: 24 }, (_, h) => ({
        hour: h,
        demand_kwh: [100,95,90,90,95,105,120,140,155,170,180,190,195,190,175,170,175,190,210,225,215,185,145,115][h],
        solar_kwh: [0,0,0,0,0,0,5,25,55,95,135,170,190,175,145,95,50,10,0,0,0,0,0,0][h],
        tariff_bdt_per_kwh: [7,6,5,5,5,6,8,10,12,14,16,17,16,15,14,15,19,24,30,34,31,21,11,8][h]
      })),
      battery: { capacity_kwh: 200, initial_energy_kwh: 100, minimum_energy_kwh: 30, max_charge_kwh_per_hour: 55, max_discharge_kwh_per_hour: 55 }
    }
  },
  {
    id: 'SAMPLE-04', label: 'No-discharge protection test',
    input: {
      scenario_id: 'SAMPLE-04',
      operator_notes: [
        'Relay protection testing is scheduled from 6 PM to 8 PM. The battery must not discharge during that time.',
        'A library book return reminder went out to all departments.'
      ],
      hours: Array.from({ length: 24 }, (_, h) => ({
        hour: h,
        demand_kwh: [95,90,85,85,90,100,115,135,150,165,175,185,190,185,170,165,170,190,210,220,210,180,140,110][h],
        solar_kwh: [0,0,0,0,0,0,5,20,55,100,140,175,195,180,150,100,50,10,0,0,0,0,0,0][h],
        tariff_bdt_per_kwh: [6,6,5,5,5,6,8,10,12,14,16,17,16,15,14,15,19,24,30,34,31,21,11,8][h]
      })),
      battery: { capacity_kwh: 230, initial_energy_kwh: 115, minimum_energy_kwh: 35, max_charge_kwh_per_hour: 55, max_discharge_kwh_per_hour: 55 }
    }
  }
]

function App() {
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  // Form state
  const [scenarioId, setScenarioId] = useState('SAMPLE-01')
  const [notes, setNotes] = useState(['', ''])
  const [selectedSample, setSelectedSample] = useState('')

  // Health check on mount
  useEffect(() => {
    fetch(`${API}/health`)
      .then(r => r.json())
      .then(d => setHealth(d.status === 'ok' ? 'ok' : 'error'))
      .catch(() => setHealth('error'))
    const iv = setInterval(() => {
      fetch(`${API}/health`)
        .then(r => r.json())
        .then(d => setHealth(d.status === 'ok' ? 'ok' : 'error'))
        .catch(() => setHealth('error'))
    }, 30000)
    return () => clearInterval(iv)
  }, [])

  // Load sample case
  function loadSample(idx) {
    if (idx === '') return
    setSelectedSample(idx)
    const sample = SAMPLES[parseInt(idx)]
    setScenarioId(sample.input.scenario_id)
    setNotes(sample.input.operator_notes)
    setError(null)
    setResult(null)
  }

  // Submit
  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const sample = selectedSample !== '' ? SAMPLES[parseInt(selectedSample)] : null
      const body = sample ? sample.input : {
        scenario_id: scenarioId,
        operator_notes: notes.filter(n => n.trim()),
        hours: Array.from({ length: 24 }, (_, h) => ({
          hour: h, demand_kwh: 100, solar_kwh: 0, tariff_bdt_per_kwh: 10
        })),
        battery: { capacity_kwh: 200, initial_energy_kwh: 100, minimum_energy_kwh: 30,
          max_charge_kwh_per_hour: 50, max_discharge_kwh_per_hour: 50 }
      }

      const res = await fetch(`${API}/optimize-energy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }

      setResult(await res.json())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <header className="header">
        <div className="header-brand">
          <div className="logo">⚡</div>
          <h1>GridWise LLM</h1>
          <span className="badge">BUP CSE Fest 2026</span>
        </div>
        <div className="header-status">
          <div className={`health-dot ${health || ''}`} />
          <span>{health === 'ok' ? 'Backend Connected' : health === 'error' ? 'Backend Offline' : 'Checking...'}</span>
        </div>
      </header>

      <div className="main">
        {/* ─── Sidebar: Input Form ─── */}
        <aside className="sidebar">
          <div className="card">
            <div className="card-header">
              <h3>📋 Quick Load Sample</h3>
            </div>
            <div className="card-body">
              <select className="sample-select" value={selectedSample} onChange={e => loadSample(e.target.value)}>
                <option value="">Select a sample case...</option>
                {SAMPLES.map((s, i) => (
                  <option key={s.id} value={i}>{s.id}: {s.label}</option>
                ))}
              </select>
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="card">
              <div className="card-header">
                <h3>⚙️ Scenario Configuration</h3>
              </div>
              <div className="card-body">
                <div className="form-group">
                  <label>Scenario ID</label>
                  <input type="text" value={scenarioId} onChange={e => setScenarioId(e.target.value)} placeholder="SAMPLE-01" />
                </div>

                <div className="form-group">
                  <label>Operator Note 1</label>
                  <textarea value={notes[0] || ''} onChange={e => { const n = [...notes]; n[0] = e.target.value; setNotes(n) }}
                    placeholder="e.g. Solar panels being cleaned from noon until 2 PM..." rows={3} />
                </div>

                <div className="form-group">
                  <label>Operator Note 2 (optional)</label>
                  <textarea value={notes[1] || ''} onChange={e => { const n = [...notes]; n[1] = e.target.value; setNotes(n) }}
                    placeholder="e.g. Library book return reminder..." rows={3} />
                </div>

                {error && <div className="error-box">❌ {error}</div>}

                <button type="submit" className="btn btn-primary" disabled={loading || health !== 'ok'}>
                  {loading ? '⏳ Optimizing...' : '🚀 Run Optimization'}
                </button>
              </div>
            </div>
          </form>
        </aside>

        {/* ─── Content: Results ─── */}
        <main className="content">
          {loading && (
            <div className="loading-overlay">
              <div className="spinner" />
              <div className="loading-text">Running LLM interpretation &amp; LP optimization...</div>
            </div>
          )}

          {!loading && !result && (
            <div className="empty-state">
              <div className="icon">⚡</div>
              <h2>No Results Yet</h2>
              <p>Load a sample case or configure your own scenario, then click "Run Optimization" to see the 24-hour energy plan.</p>
            </div>
          )}

          {!loading && result && (
            <>
              {/* Stats */}
              <div className="stats-row">
                <div className="stat-card accent">
                  <div className="stat-label">Total Cost</div>
                  <div className="stat-value">{result.total_cost_bdt?.toLocaleString()}<span className="stat-unit">BDT</span></div>
                </div>
                <div className="stat-card green">
                  <div className="stat-label">Total Grid</div>
                  <div className="stat-value">{result.total_grid_kwh?.toLocaleString()}<span className="stat-unit">kWh</span></div>
                </div>
                <div className="stat-card amber">
                  <div className="stat-label">Peak Grid Hour</div>
                  <div className="stat-value">{result.peak_grid_kwh}<span className="stat-unit">kWh</span></div>
                </div>
              </div>

              {/* Summary */}
              {result.plan_summary && (
                <div className="summary-text">"{result.plan_summary}"</div>
              )}

              {/* Directives */}
              <div className="card" style={{ marginBottom: 24 }}>
                <div className="card-header">
                  <h3>🧠 LLM Directive Interpretation</h3>
                </div>
                <div className="card-body">
                  <div className="directives">
                    {result.directive_interpretation?.map((d, i) => (
                      <div className="directive-pill" key={i}>
                        <span className={`directive-badge ${d.applies ? 'applies' : 'no-op'}`}>
                          {d.applies ? '✓ Applied' : '— No-op'}
                        </span>
                        <div>
                          <div className="directive-type">{d.directive_type}</div>
                          <div className="directive-explain">{d.explanation}</div>
                          {d.structured_adjustment && (
                            <div className="directive-explain" style={{ fontFamily: "'JetBrains Mono', monospace", marginTop: 4, color: 'var(--text-muted)' }}>
                              {JSON.stringify(d.structured_adjustment)}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Hourly Plan Table */}
              <div className="card">
                <div className="card-header">
                  <h3>📊 24-Hour Energy Plan</h3>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Hour</th>
                        <th>Grid kWh</th>
                        <th>Solar kWh</th>
                        <th>Battery</th>
                        <th>Bat kWh</th>
                        <th>Bat After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.hourly_plan?.map(p => (
                        <tr key={p.hour}>
                          <td>{String(p.hour).padStart(2, '0')}:00</td>
                          <td>{p.grid_kwh}</td>
                          <td>{p.solar_used_kwh}</td>
                          <td className={`action-${p.battery_action}`}>{p.battery_action}</td>
                          <td>{p.battery_kwh}</td>
                          <td>{p.battery_energy_after_kwh}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </>
  )
}

export default App
