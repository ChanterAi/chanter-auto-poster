import {
  ASPECT_RATIOS,
  CONTENT_TYPES,
  DEFAULT_PROMPT_EVOLVER_FORM,
  PLATFORMS,
  STYLE_PRESETS,
  findPreset
} from './promptPresets';
import { scoreVariants } from './promptScorer';

const VARIANT_BLUEPRINTS = [
  {
    title: 'Controlled Hero Frame',
    composition: 'one clear subject placed on the upper third, clean foreground, quiet background, generous negative space',
    camera: '50mm editorial lens, chest-height angle, stable framing',
    motion: 'slow dolly-in with the subject holding natural micro-movement',
    captionAngle: 'Make the idea feel like a precise statement of identity.',
    signal: 5
  },
  {
    title: 'Text-Led Poster',
    composition: 'large readable text hierarchy, subject or symbol kept secondary, strict safe margins',
    camera: 'locked-off poster composition, straight-on geometry',
    motion: 'gentle parallax on typography and background only',
    captionAngle: 'Turn the idea into a short line that can be remembered.',
    signal: 7
  },
  {
    title: 'Editorial Close-Up',
    composition: 'human face or hands as the focal anchor, calm surrounding space, no extra props',
    camera: '85mm close portrait lens, shallow realistic depth of field',
    motion: 'subtle handheld drift without shake, natural blink or fabric movement',
    captionAngle: 'Make the message feel intimate and earned.',
    signal: 4
  },
  {
    title: 'Cinematic Environment',
    composition: 'subject framed inside architecture or landscape lines, clean silhouette, readable depth',
    camera: '35mm cinematic lens, low and steady perspective',
    motion: 'slow lateral slide with stable horizon and natural motion blur',
    captionAngle: 'Build a world around the idea without adding clutter.',
    signal: 3
  },
  {
    title: 'Luxury Product Still',
    composition: 'one symbolic object paired with minimal text, premium surface, strict spacing',
    camera: '70mm product editorial lens, controlled reflections',
    motion: 'slow push past the object with no fast cuts',
    captionAngle: 'Make the idea feel expensive, quiet, and intentional.',
    signal: 6
  },
  {
    title: 'Founder Monologue Frame',
    composition: 'direct-to-camera human subject, calm posture, background simplified into two clean layers',
    camera: '40mm lens, eye-level framing, strong catchlight',
    motion: 'locked camera with natural breathing and tiny head movement',
    captionAngle: 'Make the idea sound like a founder or creator talking directly.',
    signal: 2
  },
  {
    title: 'Poster With Depth',
    composition: 'foreground subject, midground texture, distant light source, no random background details',
    camera: '45mm lens, controlled depth, poster-safe crop',
    motion: 'slow tilt from foreground texture to subject, stable and smooth',
    captionAngle: 'Give the idea atmosphere while keeping it easy to read.',
    signal: 4
  },
  {
    title: 'Silent Viral Hook',
    composition: 'first-frame clarity, strong readable text, subject centered for mobile thumb-stop impact',
    camera: 'vertical mobile-native frame, clean middle third',
    motion: 'one slow camera move only, no fast cuts unless explicitly requested',
    captionAngle: 'Make the idea instantly understandable on a phone.',
    signal: 6
  }
];

const NEGATIVE_BASE = [
  'AI slop wording',
  'generic prompt language',
  'messy overdesigned effects',
  'plastic skin',
  'warped faces',
  'extra limbs',
  'extra fingers',
  'mutated hands',
  'unreadable text',
  'misspelled text',
  'too many random visual elements',
  'busy background',
  'cheap cyberpunk look',
  'neon overload',
  'low-res artifacts',
  'uncanny eyes',
  'bad anatomy'
];

const VIDEO_NEGATIVE = [
  'chaotic camera movement',
  'jitter',
  'shaky cam',
  'fast cuts',
  'whip pans',
  'aggressive zooms',
  'flickering text',
  'text disappearing early'
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sentenceCase(value) {
  const text = normalizeText(value);
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function removeHashtagUnsafe(value) {
  return normalizeText(value)
    .replace(/[^\w\s'-]/g, '')
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 3)
    .join('');
}

function buildIdeaLabel(idea) {
  const cleaned = normalizeText(idea);
  if (!cleaned) return 'the core idea';
  return cleaned.length > 170 ? `${cleaned.slice(0, 167).trim()}...` : cleaned;
}

function buildTextInstruction(idea, presetId) {
  const cleaned = buildIdeaLabel(idea);
  if (presetId === 'premium-minimal-quote-poster' || cleaned.length <= 120) {
    return `if text is used, set the exact readable line "${cleaned}" with high contrast and safe margins`;
  }
  return `if text is used, keep it short, readable, and derived from "${cleaned}"`;
}

function buildMainPrompt({ idea, contentType, preset, platform, aspectRatio, blueprint, generation }) {
  const ideaLabel = buildIdeaLabel(idea);
  const textInstruction = buildTextInstruction(idea, preset.id);

  if (contentType.id === 'caption-pack') {
    return [
      `Create a premium ${platform.label} caption pack for: "${ideaLabel}".`,
      `Tone: ${preset.captionTone}.`,
      `Structure: one short hook, one cinematic caption, one concise CTA, and hashtags that avoid spam.`,
      `Keep it platform-ready for ${aspectRatio.label} content and avoid generic motivational filler.`
    ].join(' ');
  }

  const contentStart = contentType.id === 'video-prompt'
    ? `10-second vertical ${aspectRatio.label} video prompt`
    : `Vertical ${aspectRatio.label} premium image prompt`;

  const videoBaseline = contentType.id === 'video-prompt'
    ? ' Include cinematic 24fps motion feel, slow smooth camera movement, natural motion blur, stable framing, no jitter, no fast cuts unless requested, and keep any text readable for full duration.'
    : '';

  return [
    `${contentStart} for "${ideaLabel}".`,
    `Style: ${preset.visualIdentity}.`,
    `Subject: ${preset.subjectBias}; preserve human realism, natural anatomy, realistic skin tones, and a clear subject.`,
    `Composition: ${blueprint.composition}; ${platform.framing}.`,
    `Camera: ${blueprint.camera}.`,
    `Lighting and texture: ${preset.lighting}; ${preset.texture}.`,
    `Text direction: ${textInstruction}.`,
    `Finish: premium restraint, clean composition, cinematic mood, realistic lighting, platform-ready vertical framing.`,
    `${videoBaseline}`,
    generation > 0 ? `Evolution pass ${generation + 1}: refine the strongest previous concept and remove weaker details.` : ''
  ].filter(Boolean).join(' ');
}

function buildNegativePrompt(contentType) {
  return [...NEGATIVE_BASE, ...(contentType.id === 'video-prompt' ? VIDEO_NEGATIVE : [])].join(', ');
}

function buildCaption({ idea, contentType, preset, platform, blueprint, generation }) {
  const cleaned = sentenceCase(idea || 'Build the visual around one focused idea');
  const suffix = generation > 0 ? ' Refined again.' : '';
  if (contentType.id === 'caption-pack') {
    return [
      `1. ${cleaned}`,
      `2. ${blueprint.captionAngle}`,
      `3. Save this before the noise gets louder.${suffix}`
    ].join('\n');
  }
  if (platform.id === 'tiktok') {
    return `${cleaned}. ${blueprint.captionAngle} Keep it clean, vertical, and immediate.${suffix}`;
  }
  if (platform.id === 'instagram') {
    return `${cleaned}. ${blueprint.captionAngle} Built for a quiet, premium visual feed.${suffix}`;
  }
  return `${cleaned}. ${blueprint.captionAngle}${suffix}`;
}

function buildHashtags({ idea, preset, platform }) {
  const ideaTag = removeHashtagUnsafe(idea);
  const tags = [
    '#chanter',
    ...preset.hashtags,
    ...platform.hashtags,
    ideaTag ? `#${ideaTag.toLowerCase()}` : ''
  ].filter(Boolean);
  return Array.from(new Set(tags)).slice(0, 9).join(' ');
}

function buildVariant({ idea, contentType, preset, platform, aspectRatio, blueprint, index, generation }) {
  return {
    id: `${Date.now()}-${generation}-${index}`,
    title: blueprint.title,
    mainPrompt: buildMainPrompt({ idea, contentType, preset, platform, aspectRatio, blueprint, generation }),
    negativePrompt: buildNegativePrompt(contentType),
    suggestedCaption: buildCaption({ idea, contentType, preset, platform, blueprint, generation }),
    suggestedHashtags: buildHashtags({ idea, preset, platform }),
    variantSignal: blueprint.signal
  };
}

export function generatePromptVariants(form = {}) {
  const values = { ...DEFAULT_PROMPT_EVOLVER_FORM, ...form };
  const contentType = findPreset(CONTENT_TYPES, values.contentType, DEFAULT_PROMPT_EVOLVER_FORM.contentType);
  const preset = findPreset(STYLE_PRESETS, values.stylePreset, DEFAULT_PROMPT_EVOLVER_FORM.stylePreset);
  const platform = findPreset(PLATFORMS, values.platform, DEFAULT_PROMPT_EVOLVER_FORM.platform);
  const aspectRatio = findPreset(ASPECT_RATIOS, values.aspectRatio, DEFAULT_PROMPT_EVOLVER_FORM.aspectRatio);
  const idea = normalizeText(values.idea);
  const generation = Number.isFinite(values.generation) ? Math.max(0, values.generation) : 0;

  const variants = VARIANT_BLUEPRINTS.map((blueprint, index) => buildVariant({
    idea,
    contentType,
    preset,
    platform,
    aspectRatio,
    blueprint,
    index,
    generation
  }));

  const scoredVariants = scoreVariants(variants, {
    contentType: contentType.id,
    platform: platform.label,
    aspectRatio: aspectRatio.label
  });

  return {
    variants: scoredVariants,
    winner: scoredVariants[0],
    context: {
      contentType,
      preset,
      platform,
      aspectRatio,
      generation
    }
  };
}
