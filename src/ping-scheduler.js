'use strict';

const config = require('./config');

async function main() {
  if (!config.appUrl) {
    throw new Error('APP_URL must point to the deployed Render web service');
  }
  if (!config.cronSecret) {
    throw new Error('CRON_SECRET must be configured on both Render services');
  }

  const response = await fetch(`${config.appUrl}/api/cron/tick`, {
    headers: {
      accept: 'application/json',
      'x-cron-secret': config.cronSecret
    },
    signal: AbortSignal.timeout(15 * 60 * 1000)
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Scheduler tick returned HTTP ${response.status}: ${body.slice(0, 1000)}`);
  }

  console.log('[scheduler-ping]', body);
}

main().catch((error) => {
  console.error('[scheduler-ping] failed:', error.message || error);
  process.exitCode = 1;
});
