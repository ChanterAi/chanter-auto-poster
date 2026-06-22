'use strict';

const path = require('path');
const config = require('./config');

const PROVIDER_NAMES = ['gemini', 'openai', 'qwen'];
const CAPTION_SCHEMA = {
  type: 'object',
  properties: {
    caption: {
      type: 'string',
      description: 'One concise TikTok caption without hashtags.'
    },
    hashtags: {
      type: 'array',
      minItems: 8,
      maxItems: 15,
      items: { type: 'string' },
      description: 'Eight to fifteen specific, relevant hashtags.'
    },
    hook: {
      type: ['string', 'null'],
      description: 'An optional short opening hook, or null when it would be redundant.'
    }
  },
  required: ['caption', 'hashtags', 'hook'],
  additionalProperties: false
};

const GEMINI_CAPTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    caption: { type: 'STRING', description: 'One concise TikTok caption without hashtags.' },
    hashtags: {
      type: 'ARRAY',
      minItems: 8,
      maxItems: 15,
      items: { type: 'STRING' },
      description: 'Eight to fifteen specific, relevant hashtags.'
    },
    hook: {
      type: 'STRING',
      nullable: true,
      description: 'An optional short opening hook.'
    }
  },
  required: ['caption', 'hashtags', 'hook'],
  propertyOrdering: ['caption', 'hashtags', 'hook']
};

async function generateCaptionWithGemini(input, options = {}) {
  const settings = options.settings || config.autoCaption;
  const apiKey = options.apiKey || settings.geminiApiKey;
  if (!apiKey) throw providerError('Gemini is not configured', 'PROVIDER_NOT_CONFIGURED', 'gemini');
  assertFrames(input.frames);

  const model = String(options.model || settings.geminiModel).replace(/^models\//, '');
  const baseUrl = String(options.baseUrl || settings.geminiBaseUrl).replace(/\/+$/, '');
  const parts = [{ text: buildCaptionPrompt(input) }];
  for (const frame of input.frames) {
    parts.push({
      inline_data: {
        mime_type: frame.mimeType || 'image/jpeg',
        data: frame.data
      }
    });
  }

  const response = await fetchWithTimeout(
    options.fetchImpl || fetch,
    `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          response_mime_type: 'application/json',
          response_schema: GEMINI_CAPTION_SCHEMA
        }
      })
    },
    options.requestTimeoutMs || settings.requestTimeoutMs,
    'gemini'
  );
  const payload = await readApiResponse(response, 'Gemini caption generation', 'gemini');
  const text = payload.candidates
    && payload.candidates[0]
    && payload.candidates[0].content
    && Array.isArray(payload.candidates[0].content.parts)
    ? payload.candidates[0].content.parts.map((part) => part.text || '').join('')
    : '';
  return normalizeGeneratedCaption(text, 'gemini');
}

async function generateCaptionWithOpenAI(input, options = {}) {
  const settings = options.settings || config.autoCaption;
  const apiKey = options.apiKey || settings.openAiApiKey;
  if (!apiKey) throw providerError('OpenAI is not configured', 'PROVIDER_NOT_CONFIGURED', 'openai');
  assertFrames(input.frames);

  const content = [{ type: 'input_text', text: buildCaptionPrompt(input) }];
  for (const frame of input.frames) {
    content.push({
      type: 'input_image',
      image_url: `data:${frame.mimeType || 'image/jpeg'};base64,${frame.data}`,
      detail: 'low'
    });
  }

  const baseUrl = String(options.baseUrl || settings.openAiBaseUrl).replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    options.fetchImpl || fetch,
    `${baseUrl}/responses`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || settings.captionModel,
        input: [{ role: 'user', content }],
        text: {
          format: {
            type: 'json_schema',
            name: 'tiktok_auto_caption',
            description: 'Editable TikTok caption, hashtags, and optional hook.',
            schema: CAPTION_SCHEMA,
            strict: true
          }
        }
      })
    },
    options.requestTimeoutMs || settings.requestTimeoutMs,
    'openai'
  );
  const payload = await readApiResponse(response, 'OpenAI caption generation', 'openai');
  return normalizeGeneratedCaption(getOpenAiResponseText(payload), 'openai');
}

async function generateCaptionWithQwen(input, options = {}) {
  const settings = options.settings || config.autoCaption;
  const apiKey = options.apiKey || settings.qwenApiKey;
  if (!apiKey) throw providerError('Qwen is not configured', 'PROVIDER_NOT_CONFIGURED', 'qwen');
  assertFrames(input.frames);

  const content = [{
    type: 'text',
    text: `${buildCaptionPrompt(input)}\nReturn only the JSON object, with no Markdown fences.`
  }];
  for (const frame of input.frames) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${frame.mimeType || 'image/jpeg'};base64,${frame.data}` }
    });
  }

  const baseUrl = String(options.baseUrl || settings.qwenBaseUrl).replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    options.fetchImpl || fetch,
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || settings.qwenModel,
        messages: [{ role: 'user', content }],
        temperature: 0.4,
        max_tokens: 600
      })
    },
    options.requestTimeoutMs || settings.requestTimeoutMs,
    'qwen'
  );
  const payload = await readApiResponse(response, 'Qwen caption generation', 'qwen');
  const text = payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : '';
  return normalizeGeneratedCaption(text, 'qwen');
}

function generateFallbackCaption(input = {}) {
  const manualCaption = cleanLine(input.existingCaption);
  const title = filenameTitle(input.filename);
  const metadata = input.metadata || {};
  const caption = manualCaption
    || (title ? `A new look at ${title}.` : 'A fresh video moment, ready to watch.');
  const manualHashtags = normalizeHashtags(input.existingHashtags);
  const contextualHashtags = [];

  if (Number(metadata.height || 0) > Number(metadata.width || 0)) contextualHashtags.push('#VerticalVideo');
  if (Number(metadata.durationSeconds || 0) > 0 && Number(metadata.durationSeconds) <= 60) {
    contextualHashtags.push('#ShortVideo');
  }
  const fallbackHashtags = [
    ...manualHashtags,
    ...contextualHashtags,
    '#TikTokVideo', '#VideoContent', '#ContentCreator', '#CreativeVideo',
    '#NewVideo', '#WatchNow', '#BehindTheScenes', '#ForYou'
  ];

  return {
    caption: clampCaption(caption),
    hashtags: normalizeHashtags(fallbackHashtags).slice(0, 15),
    hook: null,
    provider: 'fallback',
    fallback: true
  };
}

async function generateAutoCaption(input, options = {}) {
  const settings = options.settings || config.autoCaption;
  const providerOrder = configuredProviderOrder(settings);
  const failures = [];

  for (const provider of providerOrder) {
    try {
      const generated = await providerGenerator(provider)(input, { ...options, settings });
      return { ...generated, provider, fallback: false, providerFailures: failures };
    } catch (error) {
      const failure = {
        provider,
        code: error.code || 'AI_PROVIDER_FAILED',
        status: Number(error.status || 0) || null
      };
      failures.push(failure);
      console.warn('[auto-caption] provider failed; trying next provider', {
        ...failure,
        message: error.message
      });
    }
  }

  return { ...generateFallbackCaption(input), providerFailures: failures };
}

function hasConfiguredCaptionProvider(settings = config.autoCaption) {
  return Boolean(settings.geminiApiKey || settings.openAiApiKey || settings.qwenApiKey);
}

function configuredProviderOrder(settings = config.autoCaption) {
  const selected = PROVIDER_NAMES.includes(settings.aiProvider) ? settings.aiProvider : 'gemini';
  const configured = {
    gemini: Boolean(settings.geminiApiKey),
    openai: Boolean(settings.openAiApiKey),
    qwen: Boolean(settings.qwenApiKey)
  };
  return [selected, 'gemini', 'openai', 'qwen']
    .filter((provider, index, values) => configured[provider] && values.indexOf(provider) === index);
}

function providerGenerator(provider) {
  if (provider === 'gemini') return generateCaptionWithGemini;
  if (provider === 'openai') return generateCaptionWithOpenAI;
  if (provider === 'qwen') return generateCaptionWithQwen;
  throw providerError(`Unsupported AI provider: ${provider}`, 'UNSUPPORTED_AI_PROVIDER', provider);
}

function buildCaptionPrompt(input = {}) {
  const transcriptText = String(input.transcript || '').trim();
  const manualContext = String(input.existingCaption || '').trim();
  const filename = String(input.filename || '').trim();
  return [
    'Create editable TikTok-ready copy from the five chronological video frames and context below.',
    'Return a JSON object with one natural short caption, 8 to 15 specific relevant hashtags, and an optional short hook.',
    'Do not invent people, brands, places, products, claims, or events that are not supported by the frames or transcript.',
    'Avoid generic hashtag stuffing. Do not include hashtags inside the caption or hook.',
    'Keep the hook plus caption under 150 characters so the current TikTok form can store it.',
    `Original filename: ${filename || 'unavailable'}`,
    `Video metadata: ${JSON.stringify(input.metadata || {})}`,
    transcriptText ? `Audio transcript: ${transcriptText}` : 'Audio transcript: unavailable or no speech detected.',
    manualContext ? `Existing user draft for context only: ${manualContext}` : 'Existing user draft: none.'
  ].join('\n');
}

function normalizeGeneratedCaption(value, provider) {
  let generated = value;
  if (typeof value === 'string') {
    const text = stripJsonFences(value);
    try {
      generated = JSON.parse(text);
    } catch (error) {
      throw providerError(`${provider} caption response was not valid JSON`, 'INVALID_AI_RESPONSE', provider, error);
    }
  }

  const caption = cleanLine(generated && generated.caption);
  const hook = cleanLine(generated && generated.hook);
  const hashtags = normalizeHashtags(generated && generated.hashtags);
  if (!caption) throw providerError(`${provider} response did not include a caption`, 'INVALID_AI_RESPONSE', provider);
  if (hashtags.length < 8 || hashtags.length > 15) {
    throw providerError(`${provider} response must include 8 to 15 unique hashtags`, 'INVALID_AI_RESPONSE', provider);
  }
  return { caption, hashtags, hook: hook || null };
}

function normalizeHashtags(values) {
  const raw = Array.isArray(values) ? values : String(values || '').split(/[\s,]+/);
  const seen = new Set();
  const result = [];
  for (const value of raw) {
    const cleaned = String(value || '')
      .trim()
      .replace(/^#+/, '')
      .replace(/[^\p{L}\p{N}_]/gu, '');
    if (!cleaned) continue;
    const key = cleaned.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(`#${cleaned}`);
  }
  return result.slice(0, 15);
}

function filenameTitle(filename) {
  const base = path.parse(String(filename || '')).name
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base || /^(?:untitled|video|clip|project|output)(?:\s+\d+)?$/i.test(base)) return '';
  return base.slice(0, 80);
}

function cleanLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampCaption(value) {
  const text = String(value || '').trim();
  if (text.length <= 150) return text;
  const shortened = text.slice(0, 147).replace(/\s+\S*$/, '').trim();
  return `${shortened || text.slice(0, 147).trim()}...`;
}

function stripJsonFences(value) {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function getOpenAiResponseText(payload) {
  if (payload && typeof payload.output_text === 'string') return payload.output_text;
  const output = Array.isArray(payload && payload.output) ? payload.output : [];
  for (const item of output) {
    for (const content of (Array.isArray(item.content) ? item.content : [])) {
      if (content && content.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  throw providerError('OpenAI response did not contain output text', 'INVALID_AI_RESPONSE', 'openai');
}

async function fetchWithTimeout(fetchImpl, url, request, timeoutMs, provider) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...request, signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw providerError(`${provider} request timed out`, 'AI_REQUEST_TIMEOUT', provider, error);
    }
    throw providerError(`${provider} request failed: ${error.message}`, 'AI_REQUEST_FAILED', provider, error);
  } finally {
    clearTimeout(timer);
  }
}

async function readApiResponse(response, label, provider) {
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; }
  catch { payload = { raw: text }; }

  if (!response.ok) {
    const reason = payload.error && payload.error.message
      ? payload.error.message
      : `${label} returned HTTP ${response.status}`;
    const error = providerError(
      reason,
      Number(response.status) === 429 ? 'AI_QUOTA_EXCEEDED' : 'AI_API_ERROR',
      provider
    );
    error.status = response.status;
    throw error;
  }
  return payload;
}

function assertFrames(frames) {
  if (!Array.isArray(frames) || frames.length !== 5 || frames.some((frame) => !frame || !frame.data)) {
    throw providerError('Exactly five representative frames are required', 'INVALID_FRAMES', 'auto-caption');
  }
}

function providerError(message, code, provider, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.provider = provider;
  return error;
}

module.exports = {
  generateCaptionWithGemini,
  generateCaptionWithOpenAI,
  generateCaptionWithQwen,
  generateFallbackCaption,
  generateAutoCaption,
  hasConfiguredCaptionProvider,
  configuredProviderOrder,
  normalizeHashtags,
  normalizeGeneratedCaption,
  buildCaptionPrompt
};
