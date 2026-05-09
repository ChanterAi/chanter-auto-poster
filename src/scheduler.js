const cron = require('node-cron');
const storage = require('./storage');
const { publishPhotoPost } = require('./tiktok');

let task = null;
let isRunning = false;

function startScheduler() {
  if (task) return task;

  task = cron.schedule('* * * * *', () => {
    publishNextPost().catch((error) => {
      console.error('[scheduler] publishNextPost failed:', error);
    });
  });

  return task;
}

async function publishNextPost() {
  if (isRunning) {
    return { ok: false, skipped: true, reason: 'Scheduler already running' };
  }

  isRunning = true;

  try {
    const duePosts = storage.getDuePendingPosts(new Date());
    if (duePosts.length === 0) {
      return { ok: true, skipped: true, reason: 'No due posts' };
    }

    return processPost(duePosts[0].id);
  } finally {
    isRunning = false;
  }
}

async function processPost(id) {
  const post = storage.getPost(id);
  if (!post) {
    return { ok: false, reason: 'Post not found' };
  }

  const result = await publishPhotoPost(post);
  const now = new Date().toISOString();

  if (result.ok) {
    storage.updatePost(id, {
      status: 'posted',
      postedAt: now,
      readyAt: null,
      lastResult: result
    });
    return { ok: true, mode: result.mode, postId: id };
  }

  if (result.mode === 'manual') {
    storage.updatePost(id, {
      status: 'ready',
      readyAt: now,
      lastResult: result
    });
    return { ok: false, mode: 'manual', postId: id, reason: result.reason };
  }

  storage.updatePost(id, {
    status: 'failed',
    lastResult: result
  });
  return { ok: false, mode: result.mode || 'api', postId: id, reason: result.reason };
}

module.exports = {
  startScheduler,
  publishNextPost,
  processPost
};
