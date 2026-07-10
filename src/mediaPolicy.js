'use strict';

// TikTok intake is video-only: every path that can create a NEW TikTok job
// (admin/campaign /upload, the client portal upload, and public-URL intake)
// must refuse images. This policy only guards creation — existing photo
// jobs stay viewable, editable, and deletable.
//
// Shared by routes.js, clientRoutes.js, and storage.js so the multer file
// filters, the route-level URL checks, and the storage chokepoint can never
// drift apart.

const path = require('path');

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm'];

const VIDEO_ONLY_UPLOAD_MESSAGE = 'TikTok posting is video-only. Upload an MP4, MOV, or WebM video.';
const VIDEO_ONLY_URL_MESSAGE = 'TikTok posting is video-only. The Public Media URL must point directly to an MP4, MOV, or WebM video file.';

function isVideoUploadFile(file) {
  const mime = String((file && file.mimetype) || '').toLowerCase();
  const extension = path.extname((file && file.originalname) || '').toLowerCase();
  if (mime.startsWith('image/')) return false;
  // A video MIME type with a non-video extension is a mismatch — reject it
  // rather than trusting either signal alone. Extension may be absent
  // (some clients omit it); the video MIME type alone is enough then.
  if (mime.startsWith('video/')) return !extension || VIDEO_EXTENSIONS.includes(extension);
  // Generic/unknown MIME (e.g. application/octet-stream): trust only a
  // known video extension.
  return VIDEO_EXTENSIONS.includes(extension);
}

function isVideoMediaUrl(mediaUrl) {
  try {
    const pathname = new URL(String(mediaUrl || '')).pathname.toLowerCase();
    return VIDEO_EXTENSIONS.some((extension) => pathname.endsWith(extension));
  } catch (error) {
    return false;
  }
}

module.exports = {
  VIDEO_EXTENSIONS,
  VIDEO_ONLY_UPLOAD_MESSAGE,
  VIDEO_ONLY_URL_MESSAGE,
  isVideoUploadFile,
  isVideoMediaUrl
};
