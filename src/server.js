const express = require('express');
const path = require('path');
const config = require('./config');
const routes = require('./routes');
const storage = require('./storage');
const { attachUser } = require('./auth');
const { startScheduler } = require('./scheduler');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(attachUser);
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(config.uploadsDir));
app.use('/', routes);

app.use((error, req, res, next) => {
  if (!error) {
    next();
    return;
  }

  console.error('[server] request error', error);

  const message = error.message || 'Unexpected server error';
  const wantsJson =
    String(req.path || '').startsWith('/api/') ||
    String(req.headers.accept || '').toLowerCase().includes('application/json') ||
    String(req.headers['content-type'] || '').toLowerCase().includes('application/json');

  if (wantsJson) {
    res.status(error.status || 500).json({
      ok: false,
      reason: message
    });
    return;
  }

  res.redirect(`/?notice=${encodeURIComponent(message)}`);
});

async function start() {
  // Fail fast and loud if Firebase credentials are missing/bad, instead of
  // booting a "healthy-looking" server that 500s on the first real request.
  await storage.ensureStorage();
  startScheduler();
  app.listen(config.port, () => {
    console.log(`${config.appName} running at http://localhost:${config.port}`);
  });
}

start().catch((error) => {
  console.error('[server] failed to start:', error);
  process.exit(1);
});

module.exports = app;
