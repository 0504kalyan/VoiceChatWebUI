/** Languages that render as a **command** block (terminal/shell), not a code editor block. */
export const COMMAND_FENCE_LANGS = new Set([
  'command',
  'cmd',
  'shell',
  'bash',
  'sh',
  'powershell',
  'pwsh',
  'terminal',
  'console',
  'zsh',
  'fish'
]);

const LOOSE_CODE_LANGS = new Set([
  'c',
  'cpp',
  'c++',
  'c#',
  'cs',
  'csharp',
  'css',
  'html',
  'java',
  'javascript',
  'js',
  'json',
  'jsx',
  'python',
  'py',
  'razor',
  'scss',
  'sql',
  'ts',
  'tsx',
  'typescript',
  'xml',
  'yaml',
  'yml'
]);

export type MessageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; alt: string; src: string }
  | { kind: 'code'; language: string; content: string }
  | { kind: 'command'; content: string; block: boolean };

/**
 * Splits assistant/user markdown-style content into segments.
 * - Fenced ```lang ... ``` → **code** (syntax area) unless `lang` is a command language → **command** (shell area).
 * - Inline backticks remain plain text so explanatory words do not become copy boxes.
 */
export function parseMessageSegments(raw: string): MessageSegment[] {
  if (!raw) return [];

  const segments: MessageSegment[] = [];
  let i = 0;

  while (i < raw.length) {
    const fence = raw.indexOf('```', i);
    if (fence === -1) {
      segments.push(...parseTextRich(raw.slice(i)));
      break;
    }
    if (fence > i) {
      segments.push(...parseTextRich(raw.slice(i, fence)));
    }

    const afterTicks = fence + 3;
    const lineEnd = raw.indexOf('\n', afterTicks);
    const lang =
      lineEnd === -1
        ? ''
        : raw
            .slice(afterTicks, lineEnd)
            .trim()
            .toLowerCase();
    const bodyStart = lineEnd === -1 ? afterTicks : lineEnd + 1;
    const close = raw.indexOf('```', bodyStart);

    if (close === -1) {
      const body = raw.slice(bodyStart);
      pushFencedSegment(segments, lang, body);
      break;
    }

    const body = raw.slice(bodyStart, close);
    pushFencedSegment(segments, lang, body);
    i = close + 3;
  }

  return mergeAdjacentText(segments);
}

/** Inline `...` split: heuristics — looks like a shell command → command, else code snippet. */
function parseTextRich(text: string): MessageSegment[] {
  if (!text) return [];

  const out: MessageSegment[] = [];
  const re = /!\[([^\]]*)\]\((data:image\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push(...parsePlainTextChunk(text.slice(last, m.index)));
    }
    out.push({ kind: 'image', alt: m[1] || 'Generated image', src: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push(...parsePlainTextChunk(text.slice(last)));
  }
  return out.length > 0 ? out : [{ kind: 'text', text }];
}

function parsePlainTextChunk(text: string): MessageSegment[] {
  return parseLooseLanguageCodeBlock(text) ?? parseTextWithInlineBackticks(text);
}

function parseLooseLanguageCodeBlock(text: string): MessageSegment[] | null {
  const match = /^(\s*)([a-zA-Z0-9#+.-]+)\s*\r?\n([\s\S]+)$/.exec(text);
  if (!match) return null;

  const lang = match[2].trim().toLowerCase();
  const content = match[3].trimEnd();
  if (!LOOSE_CODE_LANGS.has(lang) || !looksLikeCodeOrCommandBlock(content)) return null;

  const leadingWhitespace = match[1];
  const segments: MessageSegment[] = [];
  if (leadingWhitespace && leadingWhitespace.trim().length > 0) {
    segments.push({ kind: 'text', text: leadingWhitespace });
  }
  segments.push({ kind: 'code', language: lang, content });
  return segments;
}

function parseTextWithInlineBackticks(text: string): MessageSegment[] {
  if (!text) return [];

  const out: MessageSegment[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ kind: 'text', text: text.slice(last, m.index) });
    }
    out.push({ kind: 'text', text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ kind: 'text', text: text.slice(last) });
  }

  return out.length > 0 ? out : [{ kind: 'text', text }];
}

function pushFencedSegment(segments: MessageSegment[], lang: string, body: string): void {
  const content = body.trimEnd();
  if (COMMAND_FENCE_LANGS.has(lang)) {
    segments.push({ kind: 'command', content, block: true });
    return;
  }

  if (shouldRenderFenceAsPlainText(lang, content)) {
    segments.push({ kind: 'text', text: content });
    return;
  }

  segments.push({ kind: 'code', language: lang || 'text', content });
}

function shouldRenderFenceAsPlainText(lang: string, content: string): boolean {
  const normalizedLang = lang.trim().toLowerCase();
  if (normalizedLang && !['text', 'txt', 'plain', 'plaintext', 'md', 'markdown'].includes(normalizedLang)) {
    return false;
  }

  return !looksLikeCodeOrCommandBlock(content);
}

function looksLikeCodeOrCommandBlock(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (looksLikeShellCommand(t.split(/\r?\n/, 1)[0])) return true;
  if (/[{};=<>]/.test(t)) return true;
  if (/^\s*(using|namespace|public|private|protected|class|interface|record|function|const|let|var|import|export|def|async)\b/m.test(t)) {
    return true;
  }
  return false;
}

function looksLikeShellCommand(s: string): boolean {
  const t = s.trim();
  if (t.includes('\n')) return false;
  if (/^[$#>]/.test(t)) return true;
  if (/^(npm|npx|yarn|pnpm|git|docker|kubectl|curl|wget|cd|ls|cat|echo|export|sudo)\b/i.test(t)) {
    return true;
  }
  if (/^[./\\][^\s]*(\s|$)/.test(t)) return true;
  return false;
}

function mergeAdjacentText(segments: MessageSegment[]): MessageSegment[] {
  const merged: MessageSegment[] = [];
  for (const seg of segments) {
    const last = merged.at(-1);
    if (seg.kind === 'text' && last?.kind === 'text') {
      const prev = last as { kind: 'text'; text: string };
      prev.text += seg.text;
    } else if (seg.kind === 'code' && canMergeWithPreviousCode(merged, seg)) {
      mergeWithPreviousCode(merged, seg);
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

function canMergeWithPreviousCode(segments: MessageSegment[], next: { kind: 'code'; language: string; content: string }): boolean {
  const last = segments.at(-1);
  if (last?.kind === 'code') {
    return sameCodeLanguage(last.language, next.language);
  }

  const previous = segments.at(-2);
  return last?.kind === 'text' &&
    last.text.trim().length === 0 &&
    previous?.kind === 'code' &&
    sameCodeLanguage(previous.language, next.language);
}

function mergeWithPreviousCode(segments: MessageSegment[], next: { kind: 'code'; language: string; content: string }): void {
  const whitespace = segments.at(-1)?.kind === 'text' ? (segments.pop() as { kind: 'text'; text: string }).text : '';
  const previous = segments.at(-1) as { kind: 'code'; language: string; content: string };
  const gap = whitespace.includes('\n\n') ? '\n\n' : '\n';
  previous.content = `${previous.content.trimEnd()}${gap}${next.content.trimStart()}`;
}

function sameCodeLanguage(a: string, b: string): boolean {
  return normalizeCodeLanguage(a) === normalizeCodeLanguage(b);
}

function normalizeCodeLanguage(language: string): string {
  const lang = language.trim().toLowerCase();
  if (['c#', 'cs', 'csharp'].includes(lang)) return 'csharp';
  if (['js', 'javascript', 'jsx'].includes(lang)) return 'javascript';
  if (['ts', 'typescript', 'tsx'].includes(lang)) return 'typescript';
  if (['py', 'python'].includes(lang)) return 'python';
  if (['yml', 'yaml'].includes(lang)) return 'yaml';
  return lang || 'text';
}
