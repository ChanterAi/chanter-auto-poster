#!/usr/bin/env node
'use strict';

/**
 * One-time migration: copies your existing local JSON data
 * (data/posts.json, data/settings.json, data/tiktok_auth.json,
 * data/instagram_auth.json) into Firestore, using the schema the
 * Firestore-backed app now reads from.
 *
 * Run this once — locally, or as a Render "Job" — BEFORE deploying the
 * Firestore-backed code, while the old version's disk still has the
 * files (Render's disk is wiped on every restart, so this only works if
 * you run it against a currently-running instance or a local checkout
 * that still has data/*.json present).
 *
 * Usage:
 *   node scripts/migrate-to-firestore.js              # writes to Firestore
 *   node scripts/migrate-to-firestore.js --dry-run     # preview only
 */

const fs = require('fs');
const { randomUUID } = require('crypto');
const config = require('../src/config');
const { postsCollection, configDoc, Timestamp } = require('../src/firestore');

const DRY_RUN = process.argv.includes('--dry-run');

function readJsonIfExists(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (error) {
    console.warn(`[migrate] could not read ${filePath}:`, error.message);
    return fallback;
  }
}

function toTimestampOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
}

async function migratePosts() {
  const posts = readJsonIfExists(config.postsFile, []);
  if (!Array.isArray(posts) || posts.length === 0) {
    console.log('[migrate] no local posts found at', config.postsFile, '— skipping.');
    return 0;
  }

  let count = 0;
  for (const post of posts) {
    const id = post.id || randomUUID();
    // The old file-based system used "publishing" for the in-flight
    // state; the Firestore version calls it "processing". Anything
    // caught mid-flight at migration time obviously isn't actually being
    // published right now, so normalize it back to pending.
    const status = post.status === 'publishing' ? 'pending' : (post.status || 'pending');

    const doc = {
      userId: config.defaultUserId,
      platform: 'tiktok',
      originalName: post.originalName || '',
      fileName: post.fileName || '',
      mimeType: post.mimeType || '',
      mediaType: post.mediaType || 'photo',
      mediaPath: post.mediaPath || '',
      videoPath: post.videoPath || '',
      imagePath: post.imagePath || '',
      caption: post.caption || '',
      hashtags: post.hashtags || '',
      publicImageUrl: post.publicImageUrl || '',
      instagramMediaUrl: post.instagramMediaUrl || '',
      privacyLevel: post.privacyLevel || 'SELF_ONLY',
      scheduledTimeUTC: toTimestampOrNull(post.scheduledAt),
      status,
      order: Number(post.order || 0),
      createdAt: toTimestampOrNull(post.createdAt) || Timestamp.now(),
      updatedAt: Timestamp.now(),
      postedAt: toTimestampOrNull(post.postedAt),
      readyAt: toTimestampOrNull(post.readyAt),
      lastResult: post.lastResult || null,
      lastInstagramResult: post.lastInstagramResult || null,
      disableComment: Boolean(post.disableComment),
      disableDuet: Boolean(post.disableDuet),
      disableStitch: Boolean(post.disableStitch),
      contentDisclosure: Boolean(post.contentDisclosure),
      yourBrand: Boolean(post.yourBrand),
      brandedContent: Boolean(post.brandedContent),
      lockedAt: null,
      lockedBy: null,
      claimAttempts: 0
    };

    console.log(`[migrate] post ${id} (${post.originalName || 'untitled'}) -> status=${status}`);
    if (!DRY_RUN) {
      await postsCollection().doc(id).set(doc);
    }
    count += 1;
  }
  return count;
}

async function migrateConfigDoc(label, filePath, defaults) {
  const data = readJsonIfExists(filePath, null);
  if (!data) {
    console.log(`[migrate] no local ${label} found at ${filePath} — skipping.`);
    return false;
  }
  const doc = { ...defaults, ...data };
  console.log(`[migrate] ${label} ->`, DRY_RUN ? JSON.stringify(doc) : '(writing)');
  if (!DRY_RUN) {
    await configDoc(label).set(doc);
  }
  return true;
}

async function main() {
  console.log(`[migrate] starting${DRY_RUN ? ' (dry run — nothing will be written)' : ''}`);
  console.log(`[migrate] target userId: ${config.defaultUserId}`);

  const postCount = await migratePosts();

  await migrateConfigDoc('settings', config.settingsFile, { dailyPostTime: '09:00', updatedAt: null });

  await migrateConfigDoc('tiktokAuth', config.tiktokAuthFile, {
    connected: false, open_id: '', access_token: '', refresh_token: '', expires_at: null, scope: ''
  });

  await migrateConfigDoc('instagramAuth', config.instagramAuthFile, {
    connected: false, source: '', user_id: '', access_token: '', token_type: '', expires_at: null, scope: '',
    facebook_page_id: '', facebook_page_name: '', facebook_page_access_token: '',
    instagram_business_account_id: '', instagram_username: '', account_type: '', profile_picture_url: '',
    media_count: null, followers_count: null, connected_at: null, updated_at: null
  });

  console.log(`[migrate] done. Migrated ${postCount} post(s).${DRY_RUN ? ' (dry run, nothing was written)' : ''}`);
  process.exit(0);
}

main().catch((error) => {
  console.error('[migrate] failed:', error);
  process.exit(1);
});
