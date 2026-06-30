const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const routes = require('./routes');
const storage = require('./storage');
const { attachUser, csrfOriginCheck, requireAdminPage, validateAdminConfig } = require('./auth');
const { validateFirebaseConfig } = require('./firestore');
const { configureCloudinary } = require('./cloudinary');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true }));
app.use(attachUser);
app.use(csrfOriginCheck);
app.use(
  '/autoposter-dashboard',
  requireAdminPage,
  express.static(path.join(__dirname, '..', 'public', 'autoposter-dashboard'))
);
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', requireAdminPage, express.static(config.uploadsDir));
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

  res.redirect(`/private/autoposter?notice=${encodeURIComponent(message)}`);
});

async function start() {
  validateAdminConfig();
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  // Fail fast and loud if Firebase credentials are missing/bad, instead of
  // booting a "healthy-looking" server that 500s on the first real request.
  validateFirebaseConfig();
  configureCloudinary();
  await storage.ensureStorage();
  app.listen(config.port, () => {
    console.log(`${config.appName} running at http://localhost:${config.port}`);
    console.log('[scheduler] persistent mode enabled; invoke GET /api/cron/tick every minute');
  });
}

start().catch((error) => {
  console.error('[server] failed to start:', error);
  process.exit(1);
});

module.exports = app;
