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

export type MessageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; language: string; content: string }
  | { kind: 'command'; content: string; block: boolean };

/**
 * Splits assistant/user markdown-style content into segments.
 * - Fenced ```lang ... ``` → **code** (syntax area) unless `lang` is a command language → **command** (shell area).
 * - Remaining text may contain inline `` `...` `` → alternating text / **command** (short shell-like) or **code** (identifiers).
 */
export function parseMessageSegments(raw: string): MessageSegment[] {
  if (!raw) return [];

  const segments: MessageSegment[] = [];
  let i = 0;

  while (i < raw.length) {
    const fence = raw.indexOf('```', i);
    if (fence === -1) {
      segments.push(...parseTextWithInlineBackticks(raw.slice(i)));
      break;
    }
    if (fence > i) {
      segments.push(...parseTextWithInlineBackticks(raw.slice(i, fence)));
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
      if (COMMAND_FENCE_LANGS.has(lang)) {
        segments.push({ kind: 'command', content: body.trimEnd(), block: true });
      } else {
        segments.push({ kind: 'code', language: lang || 'text', content: body.trimEnd() });
      }
      break;
    }

    const body = raw.slice(bodyStart, close);
    if (COMMAND_FENCE_LANGS.has(lang)) {
      segments.push({ kind: 'command', content: body.trimEnd(), block: true });
    } else {
      segments.push({ kind: 'code', language: lang || 'text', content: body.trimEnd() });
    }
    i = close + 3;
  }

  return mergeAdjacentText(segments);
}

/** Inline `...` split: heuristics — looks like a shell command → command, else code snippet. */
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
    const inner = m[1];
    if (looksLikeShellCommand(inner)) {
      out.push({ kind: 'command', content: inner, block: false });
    } else {
      out.push({ kind: 'code', language: 'inline', content: inner });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ kind: 'text', text: text.slice(last) });
  }

  return out.length > 0 ? out : [{ kind: 'text', text }];
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
    if (seg.kind === 'text' && merged.length > 0 && merged[merged.length - 1].kind === 'text') {
      const prev = merged[merged.length - 1] as { kind: 'text'; text: string };
      prev.text += seg.text;
    } else {
      merged.push(seg);
    }
  }
  return merged;
}
