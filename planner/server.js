// AutoATC flight planner - a SimBrief-style planning site for PTFS, run as
// its own Railway service (root directory: planner/). Pilots plan a flight
// here, then import it into the companion app's MCDU/FMS by plan ID or
// callsign; the companion's autopilot then flies that route.

require('dotenv').config();

const path = require('path');
const express = require('express');
const { buildPlan } = require('./lib/plan');
const { PlanStore } = require('./lib/store');
const { navdata, airports, fixes } = require('./lib/navdata');
const { AIRCRAFT } = require('./lib/aircraft');
const { createRelayRouter } = require('./lib/relay');
const { listProcedures } = require('./lib/procedures');

const PORT = process.env.PORT || 3100;
const store = new PlanStore(process.env.PLANS_FILE || path.join(__dirname, 'data', 'plans.json'));

const app = express();
// Railway puts its proxy in front - trust it for the client's real address,
// which the relay's wrong-code lockout counts per.
app.set('trust proxy', true);

// Remote control relay + the phone page it serves (see lib/relay.js and
// public/remote/). Mounted before the JSON body parser below, which would
// otherwise reject cockpit views larger than its limit.
app.use('/remote', createRelayRouter());

app.use(express.json({ limit: '32kb' }));

// The companion app (an Electron window) and anyone else's tools call this
// API from other origins - everything here is either public reference data
// or a plan someone chose to make by its ID, so any origin may read it.
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/health', (req, res) => res.send('ok'));

app.get('/api/navdata', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ airports, fixes, fit: navdata.fit });
});

// SIDs / STARs / approaches the planner can add to a plan, for one airport.
app.get('/api/procedures/:icao', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(listProcedures(req.params.icao));
});

app.get('/api/aircraft', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(AIRCRAFT.map(({ icao, name, fms, category }) => ({ icao, name, fms, category })));
});

app.post('/api/plans', (req, res) => {
  try {
    const plan = store.add(buildPlan(req.body || {}));
    res.status(201).json(plan);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[planner] Failed to build plan:', err);
    res.status(500).json({ error: 'Could not build that plan' });
  }
});

app.get('/api/plans/:id', (req, res) => {
  const plan = store.get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'No plan with that ID' });
  res.json(plan);
});

// GET /api/plans?callsign=N42Y - the latest plan filed for that callsign.
app.get('/api/plans', (req, res) => {
  if (!req.query.callsign) return res.status(400).json({ error: 'Pass ?callsign=' });
  const plan = store.latestForCallsign(req.query.callsign);
  if (!plan) return res.status(404).json({ error: 'No plan for that callsign' });
  res.json(plan);
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route' }));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`[planner] listening on port ${PORT}`));
