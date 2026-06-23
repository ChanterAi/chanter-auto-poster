export const CONTENT_TYPES = [
  {
    id: 'image-prompt',
    label: 'Image prompt',
    outputLabel: 'image',
    focus: 'premium still image'
  },
  {
    id: 'video-prompt',
    label: 'Video prompt',
    outputLabel: 'video',
    focus: '10-second vertical video'
  },
  {
    id: 'caption-pack',
    label: 'Caption pack',
    outputLabel: 'caption pack',
    focus: 'caption and hashtag direction'
  }
];

export const STYLE_PRESETS = [
  {
    id: 'premium-minimal-quote-poster',
    label: 'Premium Minimal Quote Poster',
    visualIdentity: 'restrained black editorial poster, refined typography, generous negative space, one clear subject',
    subjectBias: 'a grounded human figure or quiet symbolic object',
    lighting: 'soft directional studio light with natural falloff',
    texture: 'matte paper grain, clean contrast, no clutter',
    captionTone: 'minimal, confident, direct',
    hashtags: ['#quote', '#minimalposter', '#dailyfocus', '#chanter']
  },
  {
    id: 'vexa-2085-cinematic',
    label: 'VEXA 2085 Cinematic',
    visualIdentity: 'near-future VEXA 2085 cinematic world, premium architecture, restrained neon accents, tactile realism',
    subjectBias: 'a realistic protagonist in a controlled futuristic environment',
    lighting: 'low-key cinematic lighting with practical neon reflections',
    texture: 'brushed metal, rain-slick surfaces, realistic skin and fabric',
    captionTone: 'cool, cinematic, high-status',
    hashtags: ['#vexa2085', '#cinematic', '#futurefilm', '#chanter']
  },
  {
    id: 'anime-cinematic-poster',
    label: 'Anime Cinematic Poster',
    visualIdentity: 'high-end anime film poster, clean facial structure, readable focal point, painterly cinematic detail',
    subjectBias: 'one expressive hero character with correct anatomy',
    lighting: 'golden rim light, controlled shadows, atmospheric depth',
    texture: 'painted film-poster finish with clean linework',
    captionTone: 'emotional, focused, poster-ready',
    hashtags: ['#animeposter', '#cinematicart', '#visualstory', '#chanter']
  },
  {
    id: 'luxury-beach-editorial',
    label: 'Luxury Beach Editorial',
    visualIdentity: 'luxury coastal editorial, refined wardrobe, Mediterranean light, expensive restraint',
    subjectBias: 'a poised human subject in linen or a clean product scene',
    lighting: 'warm natural sunset light with realistic skin tones',
    texture: 'linen, stone, water highlights, clean horizon line',
    captionTone: 'calm, elegant, editorial',
    hashtags: ['#luxuryeditorial', '#beachstyle', '#goldenhour', '#chanter']
  },
  {
    id: 'dark-motivation',
    label: 'Dark Motivation',
    visualIdentity: 'dark cinematic motivation scene, disciplined mood, focused human presence, no clutter',
    subjectBias: 'one determined person in a gym, studio, street, or quiet interior',
    lighting: 'hard side light, natural shadows, restrained highlights',
    texture: 'sweat, concrete, black fabric, subtle grain',
    captionTone: 'sharp, disciplined, intense',
    hashtags: ['#darkmotivation', '#discipline', '#mindset', '#chanter']
  }
];

export const PLATFORMS = [
  {
    id: 'tiktok',
    label: 'TikTok',
    framing: 'platform-ready TikTok-safe vertical framing with center-weighted subject placement',
    hashtags: ['#tiktokcreative', '#fyp', '#creator']
  },
  {
    id: 'instagram',
    label: 'Instagram',
    framing: 'Instagram Reels and Story safe vertical framing with clean edge spacing',
    hashtags: ['#reels', '#instagramcreative', '#visualdesign']
  },
  {
    id: 'general',
    label: 'General',
    framing: 'cross-platform vertical framing with safe margins for overlays',
    hashtags: ['#creativeprompt', '#contentidea', '#visualprompt']
  }
];

export const ASPECT_RATIOS = [
  { id: '9:16', label: '9:16' }
];

export const DEFAULT_PROMPT_EVOLVER_FORM = {
  idea: '',
  contentType: 'image-prompt',
  stylePreset: 'premium-minimal-quote-poster',
  platform: 'tiktok',
  aspectRatio: '9:16'
};

export function findPreset(items, id, fallbackId) {
  return items.find((item) => item.id === id) || items.find((item) => item.id === fallbackId) || items[0];
}
