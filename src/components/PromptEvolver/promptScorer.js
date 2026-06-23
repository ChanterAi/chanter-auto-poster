const REWARD_RULES = [
  [/realistic|real person|human|skin tones|natural anatomy|grounded/gi, 8],
  [/one clear subject|single subject|clear subject|center-weighted|focal point/gi, 8],
  [/restrained|minimal|negative space|clean composition|no clutter/gi, 9],
  [/readable text|legible|typography|safe margins|full duration/gi, 8],
  [/natural light|realistic lighting|directional light|practical light|golden hour/gi, 8],
  [/cinematic|film|24fps|motion blur|camera movement|stable framing/gi, 7],
  [/9:16|vertical|platform-ready|tiktok-safe|reels/gi, 8],
  [/slow smooth|natural motion|no jitter|no fast cuts|locked composition/gi, 7],
  [/negative prompt|warped faces|extra limbs|plastic skin|unreadable text/gi, 7],
  [/matte|grain|editorial|premium|tactile|real fabric/gi, 6]
];

const PENALTY_RULES = [
  [/masterpiece|best quality|ultra detailed|trending on artstation|award winning|8k/gi, 9],
  [/generic|beautiful scene|epic vibes|viral content|stunning visuals/gi, 7],
  [/chaotic|random|many elements|explosion|overdesigned|busy background/gi, 10],
  [/plastic skin|wax skin|warped face|extra fingers|extra limbs|mutated hands/gi, 10],
  [/unreadable text|garbled text|misspelled|tiny text/gi, 9],
  [/cheap cyberpunk|neon overload|glitch overload|lens flare overload/gi, 8],
  [/fast cuts|shaky cam|jitter|whip pan|aggressive zoom/gi, 7]
];

const VIDEO_BASELINE_TERMS = [
  '10-second vertical 9:16 video',
  'cinematic 24fps motion feel',
  'slow smooth camera movement',
  'natural motion blur',
  'stable framing',
  'no jitter',
  'no fast cuts',
  'readable for full duration'
];

function countMatches(text, regex) {
  return (text.match(regex) || []).length;
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function scoreVariant(variant, context = {}) {
  const creativeText = [
    variant.mainPrompt,
    variant.suggestedCaption,
    variant.suggestedHashtags
  ].filter(Boolean).join(' ');
  const combined = [creativeText, variant.negativePrompt].filter(Boolean).join(' ');
  const lower = combined.toLowerCase();
  let score = 52;

  REWARD_RULES.forEach(([regex, weight]) => {
    const matches = countMatches(combined, regex);
    if (matches > 0) score += Math.min(weight, matches * Math.ceil(weight / 2));
  });

  PENALTY_RULES.forEach(([regex, weight]) => {
    const matches = countMatches(creativeText, regex);
    if (matches > 0) score -= Math.min(weight + 8, matches * weight);
  });

  if (context.contentType === 'video-prompt') {
    const baselineCoverage = VIDEO_BASELINE_TERMS.filter((term) => lower.includes(term)).length;
    score += baselineCoverage * 2;
  }

  const negativePromptLength = String(variant.negativePrompt || '').split(',').filter(Boolean).length;
  if (negativePromptLength >= 10) score += 8;
  else if (negativePromptLength >= 7) score += 5;
  else score -= 8;

  const mainWords = String(variant.mainPrompt || '').trim().split(/\s+/).filter(Boolean).length;
  if (mainWords >= 55 && mainWords <= 155) score += 7;
  if (mainWords > 210) score -= 8;
  if (mainWords < 35) score -= 12;

  if (context.platform && lower.includes(context.platform.toLowerCase())) score += 3;
  if (context.aspectRatio && lower.includes(context.aspectRatio.toLowerCase())) score += 4;
  if (variant.variantSignal) score += variant.variantSignal;

  return clampScore(score);
}

export function scoreVariants(variants, context = {}) {
  return variants
    .map((variant) => ({
      ...variant,
      score: scoreVariant(variant, context)
    }))
    .sort((a, b) => b.score - a.score);
}
