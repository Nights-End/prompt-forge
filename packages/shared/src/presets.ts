import type { Preset } from './types.js';

export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'tags',
    name: 'Tags 标签式',
    description: '逗号分隔的质量词/风格词，适合 SD / Flux 等标签引擎',
    instructions: `Structure requirements (tags preset):
- Output the prompt as a single comma-separated tag list.
- Lead with quality tags (e.g. masterpiece, best quality, highly detailed).
- Follow with subject tags, then style tags (e.g. cyberpunk, cinematic lighting).
- Use English tags only; no full sentences, no numbers.
- Keep it under 100 tags unless asked otherwise.`,
  },
  {
    id: 'mj',
    name: 'MJ 参数式',
    description: '自然短句 + --ar/--v/--s 参数，适合 Midjourney',
    instructions: `Structure requirements (mj preset):
- Output as a concise descriptive phrase (3-6 short sentences at most), followed by parameter flags.
- Add Midjourney parameters when relevant: --ar <ratio>, --v <version>, --s <stylize value>.
- Describe composition, subject, environment and mood in plain English.
- Do not use markdown or bullet lists.`,
  },
  {
    id: 'plain',
    name: 'Plain 简洁描述式',
    description: '自然语言段落描述，适合文生图模型直接理解',
    instructions: `Structure requirements (plain preset):
- Output as one flowing natural-language paragraph (3-5 sentences).
- Describe the subject first, then environment, lighting, style and mood.
- Use vivid, specific adjectives; avoid generic filler words.
- English only, no markdown, no bullet lists.`,
  },
];

const SHARED_ROLE =
  'You are an expert in writing image-generation prompts. Always output the prompt in English. ' +
  'Do not add commentary, explanations or quotes around the prompt — output only the prompt itself.';

export function buildSystemPrompt(instructions: string, currentPrompt?: string): string {
  const parts = [SHARED_ROLE, instructions];
  if (currentPrompt && currentPrompt.trim()) {
    parts.push(
      `The current prompt is:\n"""${currentPrompt}"""\n` +
        'Modify and improve this prompt based on the user\'s request, rather than rewriting it from scratch.',
    );
  }
  return parts.join('\n\n');
}
