'use strict';

// CHANTER Platform customer surface: the unified shell plus the AutoPoster
// batch module (massive upload -> AI preparation -> human review -> staggered
// scheduling). Pages are Greek-first; every API returns JSON. All routes sit
// behind the same admin session and CSRF origin middleware as the classic
// console — this file adds no new authority, only a new surface over the
// existing application-service boundary.

const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('./config');
const applicationService = require('./autoposterApplicationService');
const batchService = require('./batchService');
const { requireAdminApi, requireAdminPage, resolveUserId } = require('./auth');
const { isVideoUploadFile, VIDEO_ONLY_UPLOAD_MESSAGE } = require('./mediaPolicy');

const router = express.Router();

const batchUpload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname || '').toLowerCase() || '.mp4';
      callback(null, `batch-${Date.now()}-${randomUUID()}${extension}`);
    }
  }),
  fileFilter: (req, file, callback) => {
    if (isVideoUploadFile(file)) { callback(null, true); return; }
    const error = new Error(VIDEO_ONLY_UPLOAD_MESSAGE);
    error.status = 400;
    callback(error);
  },
  limits: { files: config.batchIntake.maxItems, fileSize: 250 * 1024 * 1024 }
});

function asyncRoute(handler) {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

function websiteContext(req, options = {}) {
  const userId = resolveUserId(req);
  return applicationService.createExecutionContext({
    userId,
    actorId: options.actorId || `admin:${userId}`,
    accountId: options.accountId || '',
    source: 'website',
    workspaceId: String(req.get('x-chanter-workspace-id') || req.query.workspaceId || '').trim(),
    correlationId: req.get('x-request-id') || '',
    approval: options.approval || null,
    idempotency: { key: options.idempotencyKey || '' }
  });
}

function approverContext(req) {
  const userId = resolveUserId(req);
  return websiteContext(req, { approval: { approvedBy: `admin:${userId}` } });
}

async function removeTemporaryUploads(files) {
  for (const file of Array.isArray(files) ? files : []) {
    if (file && file.path) await fs.unlink(file.path).catch(() => {});
  }
}

function sendServiceError(res, error) {
  if (error && (error.name === 'BatchServiceError' || error.name === 'AutoPosterApplicationError')) {
    res.status(error.status || 400).json({
      ok: false,
      code: error.code || 'validation_failed',
      reason: error.message,
      details: error.details || {}
    });
    return true;
  }
  return false;
}

// ── Pages (Greek-first, admin session) ─────────────────────────────────────

router.get('/platform', requireAdminPage, (req, res) => {
  res.render('platform', { appName: config.appName });
});

router.get('/platform/autoposter', requireAdminPage, asyncRoute(async (req, res) => {
  const context = websiteContext(req);
  let accounts = [];
  let accountsError = '';
  try {
    const resolved = await applicationService.listConnectedAccounts(context, { provider: 'tiktok' });
    accounts = resolved.accounts.filter((account) => account.connectionStatus === 'connected');
  } catch (error) {
    accountsError = error.message || 'Connected channels are unavailable right now.';
  }
  res.render('platform-autoposter', {
    appName: config.appName,
    accounts,
    accountsError,
    batchDefaults: {
      staggerMinutes: config.batchIntake.staggerDefaultMinutes,
      staggerMin: config.batchIntake.staggerMinMinutes,
      staggerMax: config.batchIntake.staggerMaxMinutes,
      maxItems: config.batchIntake.maxItems
    }
  });
}));

router.get('/platform/autoposter/batches/:batchId', requireAdminPage, (req, res) => {
  res.render('platform-batch', {
    appName: config.appName,
    batchId: String(req.params.batchId || '').trim(),
    safetyBufferMinutes: config.batchIntake.safetyBufferMinutes
  });
});

// ── Batch APIs (admin session, JSON) ───────────────────────────────────────

function uploadBatchMedia(req, res, next) {
  batchUpload.array('videos')(req, res, (error) => {
    if (error) {
      res.status(error.status || 400).json({ ok: false, code: 'upload_rejected', reason: error.message || 'Upload failed.' });
      return;
    }
    next();
  });
}

router.post('/api/platform/batches', requireAdminApi, uploadBatchMedia, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const files = req.files || [];
  try {
    const result = await batchService.createBatch(websiteContext(req), {
      files,
      provider: req.body.provider,
      accountId: req.body.accountId,
      startDate: req.body.startDate,
      startTime: req.body.startTime,
      timezoneName: req.body.timezoneName,
      timezoneOffsetMinutes: req.body.timezoneOffsetMinutes,
      staggerMinutes: req.body.staggerMinutes,
      intakeKey: req.body.intakeKey
    });
    if (result.replayed) await removeTemporaryUploads(files);
    res.status(result.replayed ? 200 : 201).json({ ok: true, ...result });
  } catch (error) {
    await removeTemporaryUploads(files);
    if (!sendServiceError(res, error)) throw error;
  }
}));

router.get('/api/platform/batches', requireAdminApi, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await batchService.listBatches(websiteContext(req));
    res.json({ ok: true, ...result });
  } catch (error) {
    if (!sendServiceError(res, error)) throw error;
  }
}));

router.get('/api/platform/batches/:batchId', requireAdminApi, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await batchService.getBatchView(websiteContext(req), req.params.batchId);
    res.json({ ok: true, ...result });
  } catch (error) {
    if (!sendServiceError(res, error)) throw error;
  }
}));

router.post('/api/platform/batches/:batchId/prepare', requireAdminApi, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await batchService.resumePreparation(websiteContext(req), req.params.batchId);
    res.json({ ok: true, resumed: true, ...result });
  } catch (error) {
    if (!sendServiceError(res, error)) throw error;
  }
}));

router.patch(
  '/api/platform/batches/:batchId/items/:postId',
  requireAdminApi,
  express.json({ limit: '64kb' }),
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await batchService.updateItem(
        websiteContext(req),
        req.params.batchId,
        req.params.postId,
        {
          caption: req.body.caption,
          hashtags: req.body.hashtags,
          scheduleInput: req.body.scheduleInput
        }
      );
      res.json({ ok: true, ...result });
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  })
);

router.post(
  '/api/platform/batches/:batchId/items/:postId/accept',
  requireAdminApi,
  express.json({ limit: '16kb' }),
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await batchService.acceptItems(approverContext(req), req.params.batchId, {
        postIds: [req.params.postId]
      });
      res.json({ ok: result.failed.length === 0, ...result });
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  })
);

router.post(
  '/api/platform/batches/:batchId/accept-all',
  requireAdminApi,
  express.json({ limit: '16kb' }),
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await batchService.acceptItems(approverContext(req), req.params.batchId, {
        postIds: 'all'
      });
      res.json({ ok: result.failed.length === 0, ...result });
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  })
);

module.exports = router;
