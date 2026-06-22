'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const bundledFfmpegPath = require('ffmpeg-static');
const bundledFfprobePath = require('ffprobe-static').path;
const config = require('./config');
const {
  generateCaptionWithGemini,
  generateCaptionWithOpenAI,
  generateCaptionWithQwen,
  generateFallbackCaption,
  generateAutoCaption,
  hasConfiguredCaptionProvider,
  normalizeHashtags
} = require('./autoCaptionProviders');

const FRAME_POSITIONS = [0.08, 0.29, 0.5, 0.71, 0.92];

function resolveFfmpegPath() {
  return config.autoCaption.ffmpegPath || bundledFfmpegPath || 'ffmpeg';
}

function resolveFfprobePath() {
  return config.autoCaption.ffprobePath || bundledFfprobePath || 'ffprobe';
}

async function extractVideoFrames(videoPath, options = {}) {
  assertReadableFile(videoPath);
  const runCommand = options.runCommand || runProcess;
  const metadata = options.metadata || await probeVideo(videoPath, { runCommand });
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chanter-auto-caption-frames-'));

  try {
    const timestamps = representativeTimestamps(metadata.durationSeconds);
    const framePaths = timestamps.map((_, index) => path.join(tempDir, `frame-${index + 1}.jpg`));

    await Promise.all(framePaths.map((framePath, index) => runCommand(
      resolveFfmpegPath(),
      [
        '-hide_banner', '-loglevel', 'error',
        '-ss', timestamps[index].toFixed(3),
        '-i', videoPath,
        '-frames:v', '1',
        '-vf', 'scale=min(768\\,iw):-2',
        '-q:v', '3',
        '-y', framePath
      ],
      { timeoutMs: config.autoCaption.ffmpegTimeoutMs }
    )));

    const frames = await Promise.all(framePaths.map(async (framePath, index) => ({
      mimeType: 'image/jpeg',
      data: (await fsp.readFile(framePath)).toString('base64'),
      timestampSeconds: timestamps[index]
    })));

    if (frames.length !== 5 || frames.some((frame) => !frame.data)) {
      throw autoCaptionError('FFmpeg did not produce five usable video frames', 'FRAME_EXTRACTION_FAILED');
    }

    return { frames, metadata };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function extractAudioTranscript(videoPath, options = {}) {
  assertReadableFile(videoPath);
  const metadata = options.metadata || await probeVideo(videoPath, options);
  if (!metadata.hasAudio) {
    return { hasAudio: false, transcript: '', transcribed: false };
  }
  if (!config.autoCaption.openAiApiKey) {
    return {
      hasAudio: true,
      transcript: '',
      transcribed: false,
      skippedReason: 'OpenAI transcription is not configured'
    };
  }
  const runCommand = options.runCommand || runProcess;
  const fetchImpl = options.fetchImpl || fetch;
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chanter-auto-caption-audio-'));
  const audioPath = path.join(tempDir, 'audio.mp3');

  try {
    const ffmpegArgs = [
      '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-vn', '-ac', '1', '-ar', '16000',
      '-codec:a', 'libmp3lame', '-b:a', '48k'
    ];
    if (config.autoCaption.maxAudioSeconds > 0) {
      ffmpegArgs.push('-t', String(config.autoCaption.maxAudioSeconds));
    }
    ffmpegArgs.push('-y', audioPath);

    await runCommand(resolveFfmpegPath(), ffmpegArgs, {
      timeoutMs: config.autoCaption.ffmpegTimeoutMs
    });

    const audio = await fsp.readFile(audioPath);
    if (audio.length === 0) {
      return { hasAudio: true, transcript: '', transcribed: false };
    }

    const body = new FormData();
    body.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'audio.mp3');
    body.append('model', options.transcriptionModel || config.autoCaption.transcriptionModel);
    body.append('response_format', 'json');

    const response = await fetchWithTimeout(
      fetchImpl,
      `${config.autoCaption.openAiBaseUrl}/audio/transcriptions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.autoCaption.openAiApiKey}` },
        body
      },
      options.requestTimeoutMs || config.autoCaption.requestTimeoutMs
    );
    const payload = await readApiResponse(response, 'Audio transcription');
    const transcript = String(payload.text || '').trim().slice(0, config.autoCaption.maxTranscriptChars);

    return { hasAudio: true, transcript, transcribed: Boolean(transcript) };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

function applyAutoCaptionToJob(job, generated) {
  const current = { ...(job || {}) };
  if (!generated || !generated.caption) return current;

  const hook = cleanLine(generated.hook);
  const caption = cleanLine(generated.caption);
  const hashtagList = normalizeHashtags(generated.hashtags);
  const editableCaption = clampCaption([hook, caption].filter(Boolean).join('\n'));

  return {
    ...current,
    caption: editableCaption,
    hashtags: hashtagList.join(' '),
    autoCaption: {
      applied: true,
      generatedCaption: caption,
      hook: hook || null,
      hashtags: hashtagList,
      provider: generated.provider || '',
      fallback: Boolean(generated.fallback)
    }
  };
}

async function analyzeVideoForCaption(videoPath, draft = {}, options = {}) {
  const filename = String(options.filename || path.basename(videoPath)).trim();
  let extracted;
  try {
    extracted = await extractVideoFrames(videoPath, options);
  } catch (error) {
    console.warn('[auto-caption] media analysis failed; using local fallback:', error.message);
    const metadata = fallbackMetadata(videoPath);
    const generated = generateFallbackCaption({
      filename,
      metadata,
      existingCaption: draft.caption,
      existingHashtags: draft.hashtags
    });
    const applied = applyAutoCaptionToJob(draft, generated);
    return {
      ...applied,
      generatedCaption: generated.caption,
      hook: generated.hook,
      hashtagList: generated.hashtags,
      metadata,
      transcriptUsed: false,
      transcriptionWarning: '',
      analysisWarning: error.message,
      provider: generated.provider,
      fallbackUsed: true,
      providerFailures: []
    };
  }

  let audio = { hasAudio: extracted.metadata.hasAudio, transcript: '', transcribed: false };
  let transcriptionWarning = '';

  if (extracted.metadata.hasAudio) {
    try {
      audio = await extractAudioTranscript(videoPath, { ...options, metadata: extracted.metadata });
      transcriptionWarning = audio.skippedReason || '';
    } catch (error) {
      transcriptionWarning = error.message;
      console.warn('[auto-caption] audio transcription skipped:', error.message);
    }
  }

  const generated = await generateAutoCaption({
    frames: extracted.frames,
    transcript: audio.transcript,
    metadata: extracted.metadata,
    filename,
    existingCaption: draft.caption,
    existingHashtags: draft.hashtags
  }, options);
  const applied = applyAutoCaptionToJob(draft, generated);

  return {
    ...applied,
    generatedCaption: generated.caption,
    hook: generated.hook,
    hashtagList: generated.hashtags,
    metadata: extracted.metadata,
    transcriptUsed: audio.transcribed,
    transcriptionWarning,
    analysisWarning: '',
    provider: generated.provider,
    fallbackUsed: Boolean(generated.fallback),
    providerFailures: generated.providerFailures || []
  };
}

async function probeVideo(videoPath, options = {}) {
  const runCommand = options.runCommand || runProcess;
  const result = await runCommand(
    resolveFfprobePath(),
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', videoPath],
    { timeoutMs: config.autoCaption.ffmpegTimeoutMs }
  );

  let probe;
  try {
    probe = JSON.parse(result.stdout);
  } catch (error) {
    throw autoCaptionError('FFprobe returned invalid video metadata', 'VIDEO_PROBE_FAILED', error);
  }

  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  if (!video) throw autoCaptionError('The uploaded file does not contain a video stream', 'VIDEO_STREAM_MISSING');

  const stats = fs.statSync(videoPath);
  const duration = finiteNumber(probe.format && probe.format.duration)
    || finiteNumber(video.duration)
    || 0;

  return {
    durationSeconds: Number(duration.toFixed(3)),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    frameRate: parseFrameRate(video.avg_frame_rate || video.r_frame_rate),
    sizeBytes: finiteNumber(probe.format && probe.format.size) || stats.size,
    format: String((probe.format && probe.format.format_name) || ''),
    videoCodec: String(video.codec_name || ''),
    hasAudio: Boolean(audio),
    audioCodec: audio ? String(audio.codec_name || '') : ''
  };
}

function representativeTimestamps(durationSeconds) {
  const duration = finiteNumber(durationSeconds);
  if (duration <= 0) return FRAME_POSITIONS.map(() => 0);
  const latest = Math.max(0, duration - 0.01);
  return FRAME_POSITIONS.map((position) => Math.min(latest, Math.max(0, duration * position)));
}

function clampCaption(value) {
  const text = String(value || '').trim();
  if (text.length <= 150) return text;
  const shortened = text.slice(0, 147).replace(/\s+\S*$/, '').trim();
  return `${shortened || text.slice(0, 147).trim()}...`;
}

function cleanLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function fetchWithTimeout(fetchImpl, url, request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...request, signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw autoCaptionError('AI request timed out', 'AI_REQUEST_TIMEOUT', error);
    }
    throw autoCaptionError(`AI request failed: ${error.message}`, 'AI_REQUEST_FAILED', error);
  } finally {
    clearTimeout(timer);
  }
}

async function readApiResponse(response, label) {
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; }
  catch { payload = { raw: text }; }

  if (!response.ok) {
    const reason = payload.error && payload.error.message
      ? payload.error.message
      : `${label} returned HTTP ${response.status}`;
    throw autoCaptionError(reason, 'AI_API_ERROR');
  }
  return payload;
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeoutMs = Number(options.timeoutMs || 120_000);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(autoCaptionError(`Could not start ${path.basename(executable)}: ${error.message}`, 'FFMPEG_UNAVAILABLE', error));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(autoCaptionError(`${path.basename(executable)} timed out`, 'FFMPEG_TIMEOUT'));
        return;
      }
      if (code !== 0) {
        reject(autoCaptionError(
          `${path.basename(executable)} failed${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
          'FFMPEG_FAILED'
        ));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function appendBounded(current, chunk) {
  const next = current + String(chunk || '');
  return next.length > 32_000 ? next.slice(-32_000) : next;
}

function assertReadableFile(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  if (!filePath || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw autoCaptionError('Uploaded video file is unavailable', 'VIDEO_FILE_MISSING');
  }
}

function parseFrameRate(value) {
  const parts = String(value || '').split('/').map(Number);
  const rate = parts.length === 2 && parts[1] ? parts[0] / parts[1] : Number(value);
  return Number.isFinite(rate) ? Number(rate.toFixed(3)) : 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function fallbackMetadata(videoPath) {
  try {
    return { sizeBytes: fs.statSync(videoPath).size, hasAudio: false };
  } catch {
    return { sizeBytes: 0, hasAudio: false };
  }
}

function autoCaptionError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

module.exports = {
  extractVideoFrames,
  extractAudioTranscript,
  generateCaptionWithGemini,
  generateCaptionWithOpenAI,
  generateCaptionWithQwen,
  generateFallbackCaption,
  generateAutoCaption,
  hasConfiguredCaptionProvider,
  applyAutoCaptionToJob,
  analyzeVideoForCaption,
  probeVideo,
  normalizeHashtags,
  runProcess
};
