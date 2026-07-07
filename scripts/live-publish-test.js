'use strict';

// Controlled Live Publish Test — human-run only.
//
// This script is never invoked by the server, a cron job, a route, or any
// UI button. Running it without --execute and the exact --confirm phrase
// only prints the "LIVE PUBLISH APPROVAL REQUIRED" gate and touches
// nothing — no Firestore write, no TikTok call.
//
// Usage (print the approval gate; nothing is created):
//   node scripts/live-publish-test.js \
//     --channel chanter-open-id --channel cdwarrior-open-id \
//     --asset "One small test image, chanter-logo.png" \
//     --asset-url https://example.com/chanter-logo.png \
//     --caption "Live publish test" --tags "#chantertest" \
//     --buffer-minutes 5 --offset-minutes 5
//
// Usage (actually create the two scheduled jobs — only after a human has
// read the gate above and typed the exact approval sentence):
//   node scripts/live-publish-test.js ...same flags... \
//     --confirm "I approve the controlled live publish test." --execute

const {
  buildLivePublishPlan,
  renderLivePublishApprovalGate,
  isConfirmed
} = require('../src/livePublishTest');

function parseArgs(argv) {
  const args = { channels: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => argv[(i += 1)];
    switch (token) {
      case '--channel': args.channels.push(next()); break;
      case '--asset': args.asset = next(); break;
      case '--asset-url': args.assetUrl = next(); break;
      case '--caption': args.caption = next(); break;
      case '--tags': args.tags = next(); break;
      case '--buffer-minutes': args.bufferMinutes = Number(next()); break;
      case '--offset-minutes': args.offsetMinutes = Number(next()); break;
      case '--confirm': args.confirm = next(); break;
      case '--execute': args.execute = true; break;
      default: break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.channels.length === 0) {
    console.error('[live-publish-test] ERROR: pass at least one --channel <accountId>.');
    process.exitCode = 1;
    return;
  }

  const storage = require('../src/storage');
  const accounts = await storage.getTikTokAccounts();
  const channels = args.channels.map((accountId) => {
    const account = accounts.find((item) => item.accountId === accountId);
    return {
      accountId,
      username: account ? account.username : '',
      connected: account ? account.connected : false
    };
  });

  const plan = buildLivePublishPlan({
    channels,
    assetDescription: args.asset,
    caption: args.caption,
    tags: args.tags,
    bufferMinutes: args.bufferMinutes,
    offsetMinutes: args.offsetMinutes
  });

  if (!plan.ok) {
    console.error(`[live-publish-test] BLOCKED: ${plan.reason}`);
    process.exitCode = 1;
    return;
  }

  console.log(renderLivePublishApprovalGate(plan));

  if (!args.execute || !isConfirmed(args.confirm)) {
    console.log(
      '\n[live-publish-test] NOT EXECUTED. Re-run with --execute and the exact ' +
      '--confirm phrase only after the user has explicitly approved this test.'
    );
    process.exitCode = 1;
    return;
  }

  if (!String(args.assetUrl || '').trim()) {
    console.error('[live-publish-test] ERROR: --asset-url is required to actually execute (no local file upload from this script).');
    process.exitCode = 1;
    return;
  }

  console.log('\n[live-publish-test] Confirmed and --execute set. Creating the scheduled TikTok jobs now.');
  // Reuses the exact same storage functions the normal /upload flow uses —
  // there is no separate, less-reviewed code path for a "test" post.
  const created = await storage.addUploadedPosts(storage.DEFAULT_USER_ID, [], {
    caption: plan.caption,
    hashtags: plan.tags,
    publicMediaUrl: args.assetUrl,
    accounts: plan.channels.map((channel) => ({ accountId: channel.accountId, username: channel.username }))
  });
  const scheduledCount = await storage.applyExplicitSchedule(storage.DEFAULT_USER_ID, created, {
    baseAt: plan.firstScheduledAt,
    channels: plan.channels.map((channel) => ({
      accountId: channel.accountId,
      scheduledAt: channel.scheduledAt,
      offsetMinutes: channel.offsetMinutes,
      order: channel.order
    }))
  });

  console.log(`[live-publish-test] Created ${created.length} job(s), scheduled ${scheduledCount}.`);
  created.forEach((post) => {
    console.log(`  - ${post.id} -> accountId=${post.accountId}`);
  });
  console.log('[live-publish-test] These jobs will publish for real at their scheduled times via the normal cron/scheduler path.');
}

main().catch((error) => {
  console.error('[live-publish-test] ERROR:', error.message);
  process.exitCode = 1;
});
