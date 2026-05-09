const express = require('express');
const path = require('path');
const config = require('./config');
const routes = require('./routes');
const storage = require('./storage');
const { startScheduler } = require('./scheduler');

storage.ensureStorage();

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(config.uploadsDir));
app.use('/', routes);

app.use((error, req, res, next) => {
  if (!error) {
    next();
    return;
  }

  const message = error.message || 'Unexpected server error';
  res.redirect(`/?notice=${encodeURIComponent(message)}`);
});

startScheduler();

app.listen(config.port, () => {
  console.log(`${config.appName} running at http://localhost:${config.port}`);
});

module.exports = app;
