'use strict';

const FORBIDDEN_MATERIAL_CODE = 'PROVIDER_DIAGNOSTIC_REDACTED';
const FORBIDDEN_MATERIAL_MESSAGE = 'Provider diagnostic material was withheld by the safety boundary.';

const FORBIDDEN_KEY_PATTERN = /^(?:authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|credential(?:s|envelope)?|session(?:url|uri|locator|locatorenvelope)|upload[_-]?(?:url|uri|locator)|raw(?:body|response|payload))$/i;
const FORBIDDEN_TEXT_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:ya29\.[A-Za-z0-9._-]+|sk-(?:proj-)?[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_-]{12,})\b/i,
  /https?:\/\/[^\s"'<>]*(?:upload[_-]?id|upload-session|resumable|session(?:url|uri|locator))[^\s"'<>]*/i,
  /\b(?:upload[_-]?id|session(?:url|uri|locator)|resumable[_-]?(?:url|uri|locator))\s*[:=]\s*[^\s,"'}]+/i,
  /\b(?:access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|credential)\b\s*[:=]\s*["']?[^\s,"'}]+/i
]);

function decodedVariants(value) {
  const variants = new Set([String(value || '')]);
  let current = String(value || '');
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const decoded = decodeURIComponent(current.replace(/\+/g, '%20'));
      if (decoded === current) break;
      variants.add(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  for (const candidate of [...variants]) {
    if (/^[A-Za-z0-9+/_=-]{16,}$/.test(candidate) && candidate.length % 4 === 0) {
      try {
        const decoded = Buffer.from(candidate, 'base64').toString('utf8');
        if (/^[\x09\x0a\x0d\x20-\x7e]+$/.test(decoded)) variants.add(decoded);
      } catch {
        // Invalid base64 is simply not an encoded diagnostic variant.
      }
    }
  }
  return [...variants];
}

function containsForbiddenMaterial(value, { protectedValues = [] } = {}) {
  if (value == null) return false;
  if (typeof value === 'object') {
    if (Array.isArray(value)) return value.some((entry) => containsForbiddenMaterial(entry, { protectedValues }));
    return Object.entries(value).some(([key, entry]) => (
      FORBIDDEN_KEY_PATTERN.test(String(key))
      || containsForbiddenMaterial(entry, { protectedValues })
    ));
  }
  const variants = decodedVariants(value);
  const configured = protectedValues
    .map((entry) => String(entry || ''))
    .filter((entry) => entry.length >= 8);
  return variants.some((variant) => {
    const normalized = variant
      .replace(/\bBearer\s+\[redacted\]/gi, '')
      .replace(/\b(?:access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|credential)\b\s*[:=]\s*\[redacted\]/gi, '');
    return FORBIDDEN_TEXT_PATTERNS.some((pattern) => pattern.test(normalized))
      || configured.some((entry) => variant.includes(entry));
  });
}

function safeDiagnosticText(value, options = {}) {
  const text = String(value || '').slice(0, options.maxLength || 500);
  return containsForbiddenMaterial(text, options) ? FORBIDDEN_MATERIAL_MESSAGE : text;
}

function sanitizeProviderMaterial(value, options = {}) {
  if (value == null) return value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object') return safeDiagnosticText(value, options);
  if (Array.isArray(value)) return value.map((entry) => sanitizeProviderMaterial(entry, options));
  const safe = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY_PATTERN.test(String(key))) {
      safe[key] = '[REDACTED]';
      continue;
    }
    safe[key] = sanitizeProviderMaterial(entry, options);
  }
  return safe;
}

module.exports = {
  FORBIDDEN_MATERIAL_CODE,
  FORBIDDEN_MATERIAL_MESSAGE,
  containsForbiddenMaterial,
  safeDiagnosticText,
  sanitizeProviderMaterial
};
