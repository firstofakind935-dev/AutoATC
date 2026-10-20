// AutoATC controller applications: a small standalone web app (its own Railway service). Everything lives under
// /apply; see README.md for the environment variables.
require('dotenv').config();
const express = require('express');
const { createApplyRouter } = require('./apply');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.get('/health', (req, res) => res.send('ok'));
app.get('/', (req, res) => res.redirect('/apply/'));
app.use('/apply', createApplyRouter());

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Controller applications on :${port}/apply/`));
