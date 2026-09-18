import { useState, useEffect } from 'react'
import './index.css'
import SAMPLES from './samples.json'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000'

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
    setNotes(sample.input.operator_notes && sample.input.operator_notes.length ? [...sample.input.operator_notes] : [''])
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
      const body = sample ? {
        ...sample.input,
        scenario_id: scenarioId,
        operator_notes: notes.filter(n => n.trim())
      } : {
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
          <div className="logo">GW</div>
          <h1>GridWise LLM</h1>
          <span className="badge">BUP CSE Fest 2026</span>
        </div>
        <div className="header-status">
          <div className={`health-dot ${health || ''}`} />
          <span>{health === 'ok' ? 'Online' : health === 'error' ? 'Offline' : 'Connecting'}</span>
        </div>
      </header>

      <div className="main">
        {/* ─── Sidebar: Input Form ─── */}
        <aside className="sidebar">
          <div className="card">
            <div className="card-header">
              <h3>Quick Load Sample</h3>
              <span className="sample-counter">{SAMPLES.length} Cases</span>
            </div>
            <div className="card-body">
              <div className="select-wrapper">
                <select
                  className="sample-select"
                  value={selectedSample}
                  onChange={e => loadSample(e.target.value)}
                >
                  <option value="">Select from {SAMPLES.length} sample scenarios...</option>
                  {SAMPLES.map((s, i) => (
                    <option key={s.id} value={i}>
                      {s.id}: {s.label}
                    </option>
                  ))}
                </select>
                <div className="select-arrow">
                  <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                    <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </div>
              {selectedSample !== '' && SAMPLES[parseInt(selectedSample)] && (
                <div className="sample-meta">
                  <div className="meta-pill">Battery: {SAMPLES[parseInt(selectedSample)].input.battery.capacity_kwh} kWh</div>
                  <div className="meta-pill">Max C/D: {SAMPLES[parseInt(selectedSample)].input.battery.max_charge_kwh_per_hour} kW</div>
                  <div className="meta-pill">{SAMPLES[parseInt(selectedSample)].input.operator_notes.length} note(s)</div>
                </div>
              )}
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="card">
              <div className="card-header">
                <h3>Scenario Configuration</h3>
              </div>
              <div className="card-body">
                <div className="form-group">
                  <label>Scenario ID</label>
                  <input type="text" value={scenarioId} onChange={e => setScenarioId(e.target.value)} placeholder="SAMPLE-01" />
                </div>

                {notes.map((note, idx) => (
                  <div className="form-group" key={idx}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <label style={{ margin: 0 }}>Operator Note {idx + 1}</label>
                      {notes.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setNotes(notes.filter((_, i) => i !== idx))}
                          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-mono)' }}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <textarea
                      value={note}
                      onChange={e => {
                        const next = [...notes]
                        next[idx] = e.target.value
                        setNotes(next)
                      }}
                      placeholder={`Enter operator note ${idx + 1}...`}
                      rows={3}
                    />
                  </div>
                ))}

                {notes.length < 3 && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setNotes([...notes, ''])}
                    style={{ marginBottom: 16, width: '100%' }}
                  >
                    + Add Operator Note
                  </button>
                )}

                {error && <div className="error-box">{error}</div>}

                <button type="submit" className="btn btn-primary" disabled={loading || health !== 'ok'}>
                  {loading ? 'Optimizing...' : 'Run Optimization'}
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
              <div className="icon">//</div>
              <h2>No Results Yet</h2>
              <p>Load a sample case or configure your own scenario, then run optimization to generate the 24-hour energy schedule.</p>
            </div>
          )}

          {!loading && result && (
            <>
              {/* Stats */}
              <div className="stats-row">
                <div className="stat-card">
                  <div className="stat-label">Total Cost</div>
                  <div className="stat-value">{result.total_cost_bdt?.toLocaleString()}<span className="stat-unit">BDT</span></div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Total Grid</div>
                  <div className="stat-value">{result.total_grid_kwh?.toLocaleString()}<span className="stat-unit">kWh</span></div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Peak Grid Hour</div>
                  <div className="stat-value">{result.peak_grid_kwh}<span className="stat-unit">kWh</span></div>
                </div>
              </div>

              {/* Summary */}
              {result.plan_summary && (
                <div className="summary-text">"{result.plan_summary}"</div>
              )}

              {/* Directives */}
              <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-header">
                  <h3>LLM Directive Interpretation</h3>
                </div>
                <div className="card-body">
                  <div className="directives">
                    {result.directive_interpretation?.map((d, i) => (
                      <div className="directive-pill" key={i}>
                        <span className={`directive-badge ${d.applies ? 'applies' : 'no-op'}`}>
                          {d.applies ? 'Applied' : 'No-op'}
                        </span>
                        <div>
                          <div className="directive-type">{d.directive_type}</div>
                          <div className="directive-explain">{d.explanation}</div>
                          {d.structured_adjustment && (
                            <div className="directive-explain" style={{ fontFamily: "var(--font-mono)", marginTop: 4, color: 'var(--text-muted)' }}>
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
                  <h3>24-Hour Energy Plan</h3>
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
