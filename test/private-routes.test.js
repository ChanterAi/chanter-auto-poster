'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const storage = require('../src/storage');
const tiktok = require('../src/tiktok');
const instagram = require('../src/instagram');

storage.getPosts = async () => [{
  id: 'post-1',
  status: 'scheduled',
  originalName: 'scheduled-post.jpg',
  mediaType: 'photo',
  mediaUrl: '/assets/chanter-logo.png',
  caption: 'Scheduled TikTok post',
  hashtags: '#chanter',
  privacyLevel: 'SELF_ONLY',
  scheduledAt: new Date(Date.now() + 60_000).toISOString(),
  lastInstagramResult: { ok: false, reason: 'Hidden integration error' }
}];
storage.getSettings = async () => ({ dailyPostTime: '09:00' });
storage.getCounts = async () => ({
  total: 0,
  pending: 0,
  scheduled: 0,
  processing: 0,
  ready: 0,
  posted: 0,
  failed: 0
});
storage.getDashboardJobs = async () => [];
tiktok.getTikTokAuthStatus = async () => ({ connected: false, open_id: '' });
instagram.getInstagramAuthStatus = async () => {
  throw new Error('Instagram status must not be requested while the feature is disabled');
};

const routes = require('../src/routes');

test('serves the AutoPoster page and dashboard at both private routes', async (t) => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'src', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.userId = 'owner';
    next();
  });
  app.use(routes);

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const [autoPosterResponse, dashboardResponse] = await Promise.all([
    fetch(`${baseUrl}/private/autoposter`),
    fetch(`${baseUrl}/private/autoposter/dashboard`)
  ]);
  const [autoPosterHtml, dashboardHtml] = await Promise.all([
    autoPosterResponse.text(),
    dashboardResponse.text()
  ]);

  assert.equal(autoPosterResponse.status, 200);
  assert.match(autoPosterHtml, /Create &amp; Schedule/);
  assert.match(autoPosterHtml, /href="\/private\/autoposter\/dashboard"/);
  assert.doesNotMatch(autoPosterHtml, /Instagram/i);

  assert.equal(dashboardResponse.status, 200);
  assert.match(dashboardHtml, /AutoPoster Control Room/);

  const dashboardSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'pages', 'AutoPosterDashboard.jsx'),
    'utf8'
  );
  assert.match(dashboardSource, /href="\/private\/autoposter"/);

  let savedPatch = null;
  storage.updatePost = async (userId, postId, patch) => {
    savedPatch = patch;
    return { id: postId, ...patch };
  };
  const saveResponse = await fetch(`${baseUrl}/posts/post-1`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      caption: 'Updated TikTok post',
      hashtags: '#updated',
      privacyLevel: 'SELF_ONLY',
      scheduledAt: '',
      timezoneOffsetMinutes: '0'
    })
  });

  assert.equal(saveResponse.status, 302);
  assert.ok(savedPatch);
  assert.equal(Object.hasOwn(savedPatch, 'instagramMediaUrl'), false);
});
