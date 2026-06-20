'use strict';

const config = require('./config');

async function main() {
  if (!config.appUrl) {
    throw new Error('APP_URL must point to the deployed Render web service');
  }
  if (!config.cronSecret) {
    throw new Error('CRON_SECRET must be configured on both Render services');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);

  try {
    const response = await fetch(`${config.appUrl}/run-scheduler`, {
      headers: {
        accept: 'application/json',
        'x-cron-secret': config.cronSecret
      },
      signal: controller.signal
    });
    const body = await response.text();

    if (!response.ok) {
      throw new Error(`Scheduler trigger returned HTTP ${response.status}: ${body.slice(0, 500)}`);
    }

    console.log('[scheduler-ping]', body);
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((error) => {
  console.error('[scheduler-ping] failed:', error.message || error);
  process.exitCode = 1;
});
