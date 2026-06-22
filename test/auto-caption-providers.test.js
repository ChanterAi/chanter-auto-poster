'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const providers = require('../src/autoCaptionProviders');

const frames = Array.from({ length: 5 }, (_, index) => ({
  mimeType: 'image/jpeg',
  data: Buffer.from(`frame-${index}`).toString('base64'),
  timestampSeconds: index
}));
const input = {
  frames,
  transcript: 'The speaker introduces a new studio project.',
  filename: 'studio-launch.mp4',
  metadata: { durationSeconds: 24, width: 1080, height: 1920, hasAudio: true },
  existingCaption: '',
  existingHashtags: ''
};
const generatedPayload = {
  caption: 'A closer look at the new studio project.',
  hook: 'See what is taking shape',
  hashtags: [
    '#StudioProject', '#CreativeProcess', '#BehindTheScenes', '#NewWork',
    '#VideoCreator', '#CreativeStudio', '#WorkInProgress', '#TikTokCreative'
  ]
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

function settings(overrides = {}) {
  return {
    aiProvider: 'gemini',
    geminiApiKey: '',
    geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    geminiModel: 'gemini-2.5-flash',
    openAiApiKey: '',
    openAiBaseUrl: 'https://api.openai.com/v1',
    captionModel: 'gpt-5.5',
    qwenApiKey: '',
    qwenBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    qwenModel: 'qwen-vl-max',
    requestTimeoutMs: 10_000,
    ...overrides
  };
}

test('Gemini sends five inline frames with structured JSON configuration', async () => {
  let captured = null;
  const result = await providers.generateCaptionWithGemini(input, {
    settings: settings({ geminiApiKey: 'gemini-secret' }),
    fetchImpl: async (url, request) => {
      captured = { url, request, body: JSON.parse(request.body) };
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify(generatedPayload) }] } }]
      });
    }
  });

  assert.match(captured.url, /gemini-2\.5-flash:generateContent$/);
  assert.equal(captured.request.headers['x-goog-api-key'], 'gemini-secret');
  assert.equal(captured.body.contents[0].parts.filter((part) => part.inline_data).length, 5);
  assert.equal(captured.body.generationConfig.response_mime_type, 'application/json');
  assert.match(captured.body.contents[0].parts[0].text, /studio-launch\.mp4/);
  assert.equal(result.caption, generatedPayload.caption);
});

test('Qwen uses its OpenAI-compatible multimodal chat endpoint', async () => {
  let captured = null;
  const result = await providers.generateCaptionWithQwen(input, {
    settings: settings({ qwenApiKey: 'qwen-secret' }),
    fetchImpl: async (url, request) => {
      captured = { url, request, body: JSON.parse(request.body) };
      return jsonResponse({
        choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(generatedPayload)}\n\`\`\`` } }]
      });
    }
  });

  assert.equal(captured.url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(captured.request.headers.Authorization, 'Bearer qwen-secret');
  assert.equal(captured.body.model, 'qwen-vl-max');
  assert.equal(captured.body.messages[0].content.filter((part) => part.type === 'image_url').length, 5);
  assert.equal(result.hashtags.length, 8);
});

test('OpenAI quota failure falls through to configured Gemini', async () => {
  const calls = [];
  const result = await providers.generateAutoCaption(input, {
    settings: settings({
      aiProvider: 'openai',
      openAiApiKey: 'openai-secret',
      geminiApiKey: 'gemini-secret'
    }),
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('/responses')) {
        return jsonResponse({ error: { message: 'Quota exceeded' } }, 429);
      }
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify(generatedPayload) }] } }]
      });
    }
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/responses$/);
  assert.match(calls[1], /:generateContent$/);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.fallback, false);
  assert.deepEqual(result.providerFailures, [{ provider: 'openai', code: 'AI_QUOTA_EXCEEDED', status: 429 }]);
});

test('all provider failures return a deterministic local fallback', async () => {
  const result = await providers.generateAutoCaption({
    ...input,
    existingCaption: 'Manual copy stays available',
    existingHashtags: '#ManualTag'
  }, {
    settings: settings({
      aiProvider: 'gemini',
      geminiApiKey: 'gemini-secret',
      openAiApiKey: 'openai-secret',
      qwenApiKey: 'qwen-secret'
    }),
    fetchImpl: async () => jsonResponse({ error: { message: 'Provider unavailable' } }, 503)
  });

  assert.equal(result.provider, 'fallback');
  assert.equal(result.fallback, true);
  assert.equal(result.caption, 'Manual copy stays available');
  assert.ok(result.hashtags.length >= 8 && result.hashtags.length <= 15);
  assert.equal(result.providerFailures.length, 3);
  assert.equal(providers.hasConfiguredCaptionProvider(settings({ qwenApiKey: 'qwen-secret' })), true);
  assert.equal(providers.hasConfiguredCaptionProvider(settings()), false);
});
