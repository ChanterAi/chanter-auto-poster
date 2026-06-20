'use strict';

const { randomUUID } = require('crypto');
const { v2: cloudinary } = require('cloudinary');
const config = require('./config');

const UPLOAD_ATTEMPTS = Math.max(1, Number(config.cloudinary.uploadAttempts) || 3);
const RETRY_BASE_MS = Math.max(100, Number(config.cloudinary.retryBaseMs) || 500);
let configurationLogged = false;
let configured = false;

function configureCloudinary() {
  const status = {
    cloudNameExists: Boolean(config.cloudinary.cloudName),
    apiKeyExists: Boolean(config.cloudinary.apiKey),
    apiSecretExists: Boolean(config.cloudinary.apiSecret)
  };

  if (!configurationLogged) {
    console.log('[cloudinary] configuration', status);
    configurationLogged = true;
  }

  configured = Object.values(status).every(Boolean);
  if (configured) {
    cloudinary.config({
      cloud_name: config.cloudinary.cloudName,
      api_key: config.cloudinary.apiKey,
      api_secret: config.cloudinary.apiSecret,
      secure: true
    });
  }

  return { configured, ...status };
}

function requireCloudinary() {
  const status = configureCloudinary();
  if (status.configured) return;

  const error = new Error(
    'Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.'
  );
  error.code = 'CLOUDINARY_NOT_CONFIGURED';
  error.status = 503;
  throw error;
}

function getErrorChain(error) {
  const chain = [];
  const queue = [error];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);
    if (current.cause) queue.push(current.cause);
    if (current.error) queue.push(current.error);
  }

  return chain;
}

function classifyCloudinaryError(error) {
  const chain = getErrorChain(error);
  const codes = chain
    .flatMap((item) => [item.code, item.errno])
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value));
  const statuses = chain
    .map((item) => Number(item.http_code || item.status || item.statusCode || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const status = statuses[0] || null;
  const messages = chain.map((item) => String(item.message || '')).join(' ').toLowerCase();

  if (status === 401 || status === 403 || messages.includes('invalid api key')) {
    return {
      code: 'CLOUDINARY_CREDENTIALS_INVALID',
      retryable: false,
      message: 'Cloudinary credentials are invalid. Check the cloud name, API key, and API secret.'
    };
  }

  const transientCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENETUNREACH',
    'ECONNABORTED'
  ]);
  const retryable = codes.some((code) => transientCodes.has(code.toUpperCase())) ||
    status === 408 || status === 420 || status === 429 || (status !== null && status >= 500);

  if (retryable) {
    return {
      code: codes[0] || `CLOUDINARY_HTTP_${status}`,
      retryable: true,
      message: 'Cloudinary upload hit a temporary network or service error.'
    };
  }

  return {
    code: codes[0] || 'CLOUDINARY_UPLOAD_FAILED',
    retryable: false,
    message: status === 400
      ? 'Cloudinary rejected the media upload. Check the file type and size.'
      : 'Cloudinary media upload failed.'
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withUploadRetry(operation) {
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const failure = classifyCloudinaryError(error);
      if (!failure.retryable || attempt === UPLOAD_ATTEMPTS) {
        console.error('[cloudinary] upload failed', {
          attempts: attempt,
          code: failure.code,
          retryable: failure.retryable
        });
        const cleanError = new Error(
          failure.retryable && attempt > 1
            ? `Cloudinary upload failed after ${attempt} attempts: ${failure.message}`
            : failure.message
        );
        cleanError.code = failure.code;
        cleanError.status = failure.code === 'CLOUDINARY_CREDENTIALS_INVALID' ? 502 : 503;
        throw cleanError;
      }

      const delayMs = RETRY_BASE_MS * (2 ** (attempt - 1));
      console.warn('[cloudinary] temporary upload failure; retrying', {
        attempt,
        maxAttempts: UPLOAD_ATTEMPTS,
        delayMs,
        code: failure.code
      });
      await wait(delayMs);
    }
  }
}

function uploadBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
    stream.end(buffer);
  });
}

async function uploadMediaFile(file) {
  requireCloudinary();
  if (!file || (!file.path && !file.buffer)) {
    const error = new Error('Upload file is missing its temporary content');
    error.code = 'MEDIA_FILE_MISSING';
    error.status = 400;
    throw error;
  }

  const options = {
    resource_type: 'auto',
    folder: config.cloudinary.folder,
    public_id: `${Date.now()}-${randomUUID()}`,
    overwrite: true
  };
  const result = await withUploadRetry(() =>
    file.path
      ? cloudinary.uploader.upload(file.path, options)
      : uploadBuffer(file.buffer, options)
  );

  if (!result || !String(result.secure_url || '').startsWith('https://') || !result.public_id) {
    const error = new Error('Cloudinary upload completed without a secure media URL');
    error.code = 'CLOUDINARY_INVALID_RESPONSE';
    error.status = 502;
    throw error;
  }

  return {
    mediaUrl: result.secure_url,
    publicId: result.public_id,
    resourceType: result.resource_type || 'image',
    format: result.format || '',
    bytes: Number(result.bytes || file.size || (file.buffer && file.buffer.length) || 0)
  };
}

async function destroyMediaAsset(publicId, resourceType) {
  if (!publicId) return;
  try {
    requireCloudinary();
    await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType || 'image',
      invalidate: true
    });
  } catch (error) {
    console.warn('[cloudinary] failed to delete media asset', {
      code: classifyCloudinaryError(error).code
    });
  }
}

async function checkCloudinaryHealth({ writeTest = false } = {}) {
  const status = configureCloudinary();
  const result = {
    ok: false,
    provider: 'cloudinary',
    checkedAt: new Date().toISOString(),
    configured: status.configured,
    cloudName: status.cloudNameExists ? config.cloudinary.cloudName : null,
    apiReachable: false,
    writeTest: writeTest ? { requested: true, write: false, read: false, delete: false } : { requested: false }
  };
  if (!status.configured) {
    result.error = {
      code: 'CLOUDINARY_NOT_CONFIGURED',
      message: 'Cloudinary server credentials are not configured.'
    };
    return result;
  }

  let testAsset = null;
  try {
    const ping = await cloudinary.api.ping();
    result.apiReachable = ping && ping.status === 'ok';

    if (writeTest) {
      const dataUri = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
      testAsset = await withUploadRetry(() => cloudinary.uploader.upload(dataUri, {
        resource_type: 'image',
        folder: 'chanter-auto-poster/health',
        public_id: `${Date.now()}-${randomUUID()}`,
        overwrite: true
      }));
      result.writeTest.write = Boolean(testAsset && testAsset.public_id && testAsset.secure_url);

      const resource = await cloudinary.api.resource(testAsset.public_id, { resource_type: 'image' });
      result.writeTest.read = Boolean(resource && resource.public_id === testAsset.public_id);

      const destroyed = await cloudinary.uploader.destroy(testAsset.public_id, {
        resource_type: 'image',
        invalidate: true
      });
      result.writeTest.delete = Boolean(destroyed && ['ok', 'not found'].includes(destroyed.result));
      testAsset = null;
    }

    result.ok = result.apiReachable &&
      (!writeTest || (result.writeTest.write && result.writeTest.read && result.writeTest.delete));
    return result;
  } catch (error) {
    const failure = classifyCloudinaryError(error);
    result.error = { code: failure.code, message: failure.message };
    return result;
  } finally {
    if (testAsset && testAsset.public_id) {
      try {
        await cloudinary.uploader.destroy(testAsset.public_id, {
          resource_type: testAsset.resource_type || 'image',
          invalidate: true
        });
      } catch (cleanupError) {
        // The health response already reports the primary failure.
      }
    }
  }
}

module.exports = {
  configureCloudinary,
  uploadMediaFile,
  destroyMediaAsset,
  checkCloudinaryHealth
};
