'use strict';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.AI_PROVIDER = 'openai';
process.env.GEMINI_API_KEY = '';
process.env.QWEN_API_KEY = '';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpegPath = require('ffmpeg-static');
const autoCaption = require('../src/autoCaption');

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

test('extracts five real frames, probes audio, and transcribes extracted audio', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-auto-caption-test-'));
  const videoPath = path.join(tempDir, 'sample.mp4');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  await autoCaption.runProcess(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=12',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=16000',
    '-t', '2', '-shortest',
    '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-y', videoPath
  ], { timeoutMs: 30_000 });

  const extracted = await autoCaption.extractVideoFrames(videoPath);
  assert.equal(extracted.frames.length, 5);
  assert.ok(extracted.frames.every((frame) => frame.mimeType === 'image/jpeg' && frame.data.length > 100));
  assert.equal(extracted.metadata.width, 320);
  assert.equal(extracted.metadata.height, 240);
  assert.equal(extracted.metadata.hasAudio, true);
  assert.ok(extracted.metadata.durationSeconds >= 1.9);

  let transcriptionRequest = null;
  const audio = await autoCaption.extractAudioTranscript(videoPath, {
    metadata: extracted.metadata,
    fetchImpl: async (url, request) => {
      transcriptionRequest = { url, request };
      return jsonResponse({ text: 'A short spoken transcript.' });
    }
  });

  assert.equal(audio.transcribed, true);
  assert.equal(audio.transcript, 'A short spoken transcript.');
  assert.match(transcriptionRequest.url, /\/audio\/transcriptions$/);
  assert.equal(transcriptionRequest.request.body.get('model'), 'gpt-4o-mini-transcribe');
  assert.ok(transcriptionRequest.request.body.get('file').size > 0);
});

test('generates structured copy from five frames and applies it without mutating the source job', async () => {
  const frames = Array.from({ length: 5 }, (_, index) => ({
    mimeType: 'image/jpeg',
    data: Buffer.from(`frame-${index}`).toString('base64'),
    timestampSeconds: index
  }));
  let requestBody = null;
  const generated = await autoCaption.generateCaptionWithOpenAI({
    frames,
    transcript: 'Fresh bread coming out of the oven.',
    metadata: { durationSeconds: 8, width: 1080, height: 1920, hasAudio: true },
    existingCaption: 'Bakery morning'
  }, {
    fetchImpl: async (url, request) => {
      requestBody = JSON.parse(request.body);
      return jsonResponse({
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: JSON.stringify({
              caption: 'Fresh from the oven and worth the wait.',
              hook: 'Watch the final reveal',
              hashtags: [
                '#FreshBread', '#Baking', '#Bakery', '#FoodTok', '#BehindTheScenes',
                '#BreadLovers', '#MadeFromScratch', '#FreshFromTheOven'
              ]
            })
          }]
        }]
      });
    }
  });

  assert.equal(requestBody.input[0].content.filter((part) => part.type === 'input_image').length, 5);
  assert.equal(requestBody.text.format.type, 'json_schema');
  assert.equal(generated.hashtags.length, 8);

  const source = { id: 'draft-1', caption: 'Manual fallback', hashtags: '#manual' };
  const applied = autoCaption.applyAutoCaptionToJob(source, generated);
  assert.equal(source.caption, 'Manual fallback');
  assert.equal(applied.caption, 'Watch the final reveal\nFresh from the oven and worth the wait.');
  assert.match(applied.hashtags, /^#FreshBread/);
  assert.equal(applied.autoCaption.applied, true);
  assert.deepEqual(autoCaption.applyAutoCaptionToJob(source, null), source);
});

test('rejects generated copy with fewer than eight unique hashtags', async () => {
  const frames = Array.from({ length: 5 }, () => ({
    mimeType: 'image/jpeg',
    data: Buffer.from('frame').toString('base64')
  }));

  await assert.rejects(
    autoCaption.generateCaptionWithOpenAI({ frames }, {
      fetchImpl: async () => jsonResponse({
        output: [{ content: [{
          type: 'output_text',
          text: JSON.stringify({ caption: 'Caption', hook: null, hashtags: ['#one', '#two'] })
        }] }]
      })
    }),
    (error) => error.code === 'INVALID_AI_RESPONSE'
  );
});

test('uses a local fallback when media extraction cannot run', async () => {
  const result = await autoCaption.analyzeVideoForCaption(
    path.join(os.tmpdir(), 'missing-auto-caption-video.mp4'),
    { caption: 'Keep this manual caption', hashtags: '#manual' },
    { filename: 'launch-demo.mp4' }
  );

  assert.equal(result.provider, 'fallback');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.caption, 'Keep this manual caption');
  assert.ok(result.hashtagList.length >= 8);
  assert.match(result.analysisWarning, /unavailable/i);
});
