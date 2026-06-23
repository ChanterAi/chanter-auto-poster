'use strict';

process.env.AUTO_MUSIC_TOKEN_SECRET = 'test-auto-music-token-secret';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpegPath = require('ffmpeg-static');
const config = require('../src/config');
const autoCaption = require('../src/autoCaption');
const autoMusic = require('../src/autoMusic');

async function probeVideoStreamDuration(filePath) {
  const result = await autoCaption.runProcess(require('ffprobe-static').path, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ], { timeoutMs: 30_000 });
  const duration = Number(String(result.stdout || '').trim());
  assert.ok(Number.isFinite(duration) && duration > 0, `expected ffprobe video duration for ${filePath}`);
  return Number(duration.toFixed(3));
}

test('loads the five-category catalog and selects the requested music profile', async () => {
  const catalog = await autoMusic.loadMusicCatalog();
  assert.equal(catalog.length, 5);
  assert.deepEqual(
    new Set(catalog.map((track) => track.category)),
    new Set([
      'anime-epic',
      'cyberpunk-dark',
      'motivation-calm',
      'emotional-orchestral',
      'aggressive-trap'
    ])
  );

  const selected = autoMusic.selectMusicTrack({
    musicCategory: 'cyberpunk-dark',
    musicMood: 'dark futuristic neon',
    musicIntensity: 0.7,
    musicTags: ['technology', 'sci-fi']
  }, catalog);
  assert.equal(selected.category, 'cyberpunk-dark');
  assert.equal(selected.id, 'cyberpunk-dark-demo-01');
});

test('mixes local music across the full video with and without original audio', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-auto-music-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const catalog = await autoMusic.loadMusicCatalog();
  const track = catalog.find((entry) => entry.category === 'motivation-calm');

  for (const hasAudio of [true, false]) {
    const sourcePath = path.join(tempDir, hasAudio ? 'with-audio.mp4' : 'silent.mp4');
    const outputPath = path.join(tempDir, hasAudio ? 'mixed-audio.mp4' : 'mixed-silent.mp4');
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=12'
    ];
    if (hasAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100');
    args.push(
      '-t', '2',
      ...(hasAudio ? ['-shortest'] : []),
      '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p',
      ...(hasAudio ? ['-c:a', 'aac'] : []),
      '-y', sourcePath
    );
    await autoCaption.runProcess(ffmpegPath, args, { timeoutMs: 30_000 });

    const metadata = await autoCaption.probeVideo(sourcePath);
    const inputDuration = await probeVideoStreamDuration(sourcePath);
    const rendered = await autoMusic.mixBackgroundMusic(
      sourcePath,
      track.absolutePath,
      outputPath,
      metadata,
      { timeoutMs: 30_000 }
    );
    const outputDuration = await probeVideoStreamDuration(outputPath);
    const outputMetadata = await autoCaption.probeVideo(outputPath);
    const durationDiff = Math.abs(inputDuration - outputDuration);

    assert.equal(rendered.hasOriginalAudio, hasAudio);
    assert.equal(rendered.musicVolume, hasAudio ? config.autoMusic.backgroundVolume : 1);
    assert.equal(outputMetadata.hasAudio, true);
    assert.ok(durationDiff < 0.2, `expected duration drift under 0.2s, got ${durationDiff.toFixed(3)}s`);
    assert.equal(rendered.durationSeconds, inputDuration);
    assert.equal(rendered.renderedDurationSeconds, outputDuration);
    assert.ok(fs.statSync(outputPath).size > 1_000);
  }
});

test('loops short music and keeps rendered duration aligned to the original video', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-auto-music-loop-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const sourcePath = path.join(tempDir, 'video.mp4');
  const shortMusicPath = path.join(tempDir, 'short-music.mp3');
  const outputPath = path.join(tempDir, 'mixed-looped.mp4');

  await autoCaption.runProcess(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=12',
    '-t', '3',
    '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p',
    '-y', sourcePath
  ], { timeoutMs: 30_000 });
  await autoCaption.runProcess(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100',
    '-t', '0.7',
    '-c:a', 'libmp3lame', '-b:a', '96k',
    '-y', shortMusicPath
  ], { timeoutMs: 30_000 });

  const inputMetadata = await autoCaption.probeVideo(sourcePath);
  const inputDuration = await probeVideoStreamDuration(sourcePath);
  const rendered = await autoMusic.mixBackgroundMusic(
    sourcePath,
    shortMusicPath,
    outputPath,
    inputMetadata,
    { timeoutMs: 30_000 }
  );
  const outputDuration = await probeVideoStreamDuration(outputPath);
  const outputMetadata = await autoCaption.probeVideo(outputPath);
  const durationDiff = Math.abs(inputDuration - outputDuration);

  assert.equal(rendered.hasOriginalAudio, false);
  assert.equal(rendered.musicVolume, 1);
  assert.equal(outputMetadata.hasAudio, true);
  assert.ok(durationDiff < 0.2, `expected duration drift under 0.2s, got ${durationDiff.toFixed(3)}s`);
  assert.equal(rendered.durationSeconds, inputDuration);
  assert.equal(rendered.renderedDurationSeconds, outputDuration);
  assert.ok(outputDuration <= inputDuration + 0.2);
  assert.ok(fs.statSync(outputPath).size > 1_000);
});

test('binds prepared video tokens to the user, original upload, and rendered file', async (t) => {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const renderedFileName = 'auto-music-11111111-1111-4111-8111-111111111111.mp4';
  const renderedPath = path.join(config.uploadsDir, renderedFileName);
  fs.writeFileSync(renderedPath, Buffer.from('rendered-video'));
  t.after(() => fs.rmSync(renderedPath, { force: true }));

  const token = autoMusic.createPreparedMediaToken({
    userId: 'owner-a',
    originalName: 'source.mov',
    originalSize: 4321,
    renderedFileName,
    renderedSize: fs.statSync(renderedPath).size,
    trackId: 'anime-epic-demo-01',
    trackCategory: 'anime-epic',
    trackMood: 'heroic uplifting'
  });
  const file = { originalname: 'source.mov', size: 4321 };
  const verified = autoMusic.verifyPreparedMediaToken(token, { userId: 'owner-a', file });

  assert.equal(verified.file.path, renderedPath);
  assert.equal(verified.file.mimetype, 'video/mp4');
  assert.equal(verified.trackCategory, 'anime-epic');
  assert.equal(autoMusic.verifyPreparedMediaToken(`${token}x`, { userId: 'owner-a', file }), null);
  assert.equal(autoMusic.verifyPreparedMediaToken(token, { userId: 'owner-b', file }), null);
  assert.equal(autoMusic.verifyPreparedMediaToken(token, {
    userId: 'owner-a',
    file: { originalname: 'other.mov', size: 4321 }
  }), null);
});
