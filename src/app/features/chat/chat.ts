import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  signal,
  untracked,
  viewChild
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { ChatApiService, ConversationListItem, MessageDto } from '../../core/services/chat-api.service';
import { ChatHubService } from '../../core/services/chat-hub.service';
import { VoiceService } from '../../core/services/voice.service';
import { MessageBodyComponent } from './message-body.component';

@Component({
  selector: 'app-chat',
  imports: [CommonModule, FormsModule, MessageBodyComponent],
  templateUrl: './chat.html',
  styleUrl: './chat.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ChatComponent implements OnInit, OnDestroy {
  private readonly api = inject(ChatApiService);
  private readonly hub = inject(ChatHubService);
  private readonly voice = inject(VoiceService);
  readonly auth = inject(AuthService);

  private readonly messagesScroll = viewChild<ElementRef<HTMLElement>>('messagesScroll');
  private readonly composerInput = viewChild<ElementRef<HTMLTextAreaElement>>('composerInput');

  readonly conversations = signal<ConversationListItem[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly messages = signal<MessageDto[]>([]);
  readonly streaming = signal('');
  readonly error = signal<string | null>(null);

  /**
   * Conversations that currently have an in-flight assistant stream. Independent from the selected thread —
   * you can open another chat and send while a previous one still generates on the server.
   */
  private readonly generatingConversationIds = signal<ReadonlySet<string>>(new Set());

  /** True when the selected conversation has an active generation (composer Stop / disabled state). */
  readonly busyForSelected = computed(() => {
    const id = this.selectedId();
    return id !== null && this.generatingConversationIds().has(id);
  });
  readonly voiceSupported = this.voice.supported;
  readonly listening = this.voice.listening;
  readonly speechDetected = this.voice.speechDetected;

  /** Friendly empty state before the first message (including when no conversation exists yet). */
  readonly showWelcome = computed(
    () => this.messages().length === 0 && !this.streaming() && !this.busyForSelected()
  );

  private setConversationGenerating(conversationId: string, generating: boolean): void {
    const next = new Set(this.generatingConversationIds());
    if (generating) next.add(conversationId);
    else next.delete(conversationId);
    this.generatingConversationIds.set(next);
  }

  input = '';
  /** When set, sending will truncate the thread from this user message and resend. */
  pendingEditMessageId: string | null = null;

  /** Message id (or `__streaming__`) that recently copied — shows “Copied” on the matching button. */
  readonly copyFeedbackId = signal<string | null>(null);
  private copyFeedbackClear: ReturnType<typeof setTimeout> | null = null;

  /**
   * Coalesce SignalR tokens to at most one Angular update per animation frame (ChatGPT-like smoothness).
   * Without this, hundreds of micro-updates/sec stall the UI.
   */
  private streamTokenBuffer = '';
  private streamFlushRaf: number | null = null;

  readonly title = computed(() => {
    const id = this.selectedId();
    if (!id) return 'VoiceChat';
    const c = this.conversations().find((x) => x.id === id);
    return c?.title || 'New chat';
  });

  /** Sidebar + tooltips: ChatGPT-style label until a summarized title exists. */
  displayThreadTitle(c: ConversationListItem): string {
    const t = c.title?.trim();
    return t && t.length > 0 ? t : 'New chat';
  }

  /** Model tag stored for the selected conversation (Ollama). */
  readonly selectedConversationModel = computed(() => {
    const id = this.selectedId();
    if (!id) return null;
    return this.conversations().find((c) => c.id === id)?.model ?? null;
  });

  /** Pulled model names from Ollama (`ollama list` via API). */
  private readonly ollamaModelNames = signal<string[]>([]);

  /** Options in the header dropdown: union of Ollama list + current thread model. */
  readonly modelSelectOptions = computed(() => {
    const set = new Set<string>(this.ollamaModelNames());
    const cur = this.selectedConversationModel();
    if (cur) set.add(cur);
    return [...set].sort((a, b) => a.localeCompare(b));
  });

  /**
   * When true, new content keeps the thread pinned to the bottom. Set false when the user scrolls up
   * (e.g. to read earlier messages while the assistant is still streaming).
   */
  private stickToBottom = true;

  constructor() {
    effect(() => {
      this.messages();
      this.streaming();
      untracked(() => {
        queueMicrotask(() => this.scrollMessagesToEnd());
      });
    });
  }

  /** Called from the messages panel scroll — user can scroll to top during generation. */
  onMessagesScroll(): void {
    const el = this.messagesScroll()?.nativeElement;
    if (!el) return;
    this.stickToBottom = this.isNearBottom(el);
  }

  private isNearBottom(el: HTMLElement, thresholdPx = 96): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
  }

  private scrollMessagesToEnd(): void {
    const el = this.messagesScroll()?.nativeElement;
    if (!el) return;
    if (!this.stickToBottom) return;
    el.scrollTop = el.scrollHeight;
  }

  private flushStreamTokenBuffer(): void {
    this.streamFlushRaf = null;
    if (this.streamTokenBuffer.length === 0) return;
    const chunk = this.streamTokenBuffer;
    this.streamTokenBuffer = '';
    this.streaming.update((s) => s + chunk);
  }

  private scheduleStreamFlush(): void {
    if (this.streamFlushRaf !== null) return;
    this.streamFlushRaf = requestAnimationFrame(() => this.flushStreamTokenBuffer());
  }

  /** Apply any pending streamed text before clearing state (end of stream / error). */
  private finalizeStreamingBuffer(): void {
    if (this.streamFlushRaf !== null) {
      cancelAnimationFrame(this.streamFlushRaf);
      this.streamFlushRaf = null;
    }
    this.flushStreamTokenBuffer();
  }

  private clearStreamingPipeline(): void {
    if (this.streamFlushRaf !== null) {
      cancelAnimationFrame(this.streamFlushRaf);
      this.streamFlushRaf = null;
    }
    this.streamTokenBuffer = '';
    this.streaming.set('');
  }

  /** Avoid `[object Object]` when Angular passes HttpErrorResponse to the template. */
  private formatError(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const body = e.error;
      if (body && typeof body === 'object') {
        const o = body as Record<string, unknown>;
        if (typeof o['message'] === 'string' && o['message'].length > 0) return o['message'];
        if (typeof o['detail'] === 'string' && o['detail'].length > 0) return o['detail'];
        if (typeof o['title'] === 'string' && o['title'].length > 0) return o['title'];
      }
      if (typeof body === 'string' && body.length > 0) return body;
      if (e.status === 0) return 'Network error — check the API is running.';
      if (e.statusText) return `${e.status} ${e.statusText}`.trim();
      return `HTTP ${e.status}`;
    }
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
    try {
      return JSON.stringify(e);
    } catch {
      return 'Something went wrong.';
    }
  }

  /** True if delete failed because the row is already gone (safe to drop from UI). */
  private static isDeleteAlreadyGone(e: unknown): boolean {
    return e instanceof HttpErrorResponse && e.status === 404;
  }

  private async removeEmptyConversationIfAny(): Promise<void> {
    const id = this.selectedId();
    if (!id || this.messages().length > 0) return;

    try {
      await firstValueFrom(this.api.deleteConversation(id));
    } catch (e) {
      if (!ChatComponent.isDeleteAlreadyGone(e)) {
        this.error.set(this.formatError(e));
        return;
      }
    }
    this.conversations.update((list) => list.filter((c) => c.id !== id));
    this.selectedId.set(null);
    this.messages.set([]);
  }

  async ngOnInit(): Promise<void> {
    this.loadOllamaModels();

    await this.hub.start({
      onToken: (cid, token) => {
        if (cid !== this.selectedId()) return;
        this.streamTokenBuffer += token;
        this.scheduleStreamFlush();
      },
      onComplete: (cid) => {
        this.setConversationGenerating(cid, false);
        this.refreshConversationList();
        if (cid !== this.selectedId()) return;
        this.finalizeStreamingBuffer();
        this.streaming.set('');
        // Sync from server so message IDs match DB (needed for edit / delete-from).
        this.api.getMessages(cid).subscribe({
          next: (msgs) => this.messages.set(msgs),
          error: (e) => this.error.set(this.formatError(e))
        });
      },
      onError: (cid, message) => {
        this.setConversationGenerating(cid, false);
        if (cid !== this.selectedId()) return;
        this.finalizeStreamingBuffer();
        this.error.set(message);
        this.streaming.set('');
      },
      onCancelled: (cid) => {
        this.setConversationGenerating(cid, false);
        this.refreshConversationList();
        if (cid !== this.selectedId()) return;
        this.finalizeStreamingBuffer();
        this.streaming.set('');
        this.api.getMessages(cid).subscribe({
          next: (msgs) => this.messages.set(msgs),
          error: (e) => this.error.set(this.formatError(e))
        });
      }
    });

    this.api.listConversations().subscribe({
      next: async (list) => {
        this.conversations.set(list);
        if (list.length > 0) await this.selectConversation(list[0].id);
        else {
          this.selectedId.set(null);
          this.messages.set([]);
        }
      },
      error: (e) => this.error.set(this.formatError(e))
    });
  }

  /** Reload threads so summarized titles (and order) match the server after each reply. */
  private refreshConversationList(): void {
    this.api.listConversations().subscribe({
      next: (list) => this.conversations.set(list),
      error: () => {}
    });
  }

  private loadOllamaModels(): void {
    this.api.getOllamaModels().subscribe({
      next: (res) => {
        const ok = res.ok !== false && !res.error;
        this.ollamaModelNames.set(ok ? (res.models ?? []) : []);
      },
      error: () => this.ollamaModelNames.set([])
    });
  }

  /** Header dropdown — switches model for subsequent replies in this thread (Cursor-style). */
  onConversationModelChange(model: string): void {
    const id = this.selectedId();
    const current = this.selectedConversationModel();
    if (!id || !model || model === current) return;
    this.error.set(null);
    this.api.patchConversation(id, { model }).subscribe({
      next: (dto) => {
        this.conversations.update((list) =>
          list.map((c) => (c.id === id ? { ...c, model: dto.model, updatedAt: dto.updatedAt } : c))
        );
      },
      error: (e) => this.error.set(this.formatError(e))
    });
  }

  ngOnDestroy(): void {
    if (this.copyFeedbackClear !== null) clearTimeout(this.copyFeedbackClear);
    if (this.streamFlushRaf !== null) cancelAnimationFrame(this.streamFlushRaf);
    this.voice.stop();
  }

  async newConversation(): Promise<void> {
    await this.removeEmptyConversationIfAny();
    this.error.set(null);
    this.pendingEditMessageId = null;
    this.api.createConversation({}).subscribe({
      next: async (c) => {
        this.conversations.update((x) => [c, ...x]);
        await this.selectConversation(c.id);
      },
      error: (e) => this.error.set(this.formatError(e))
    });
  }

  async selectConversation(id: string): Promise<void> {
    if (id === this.selectedId()) return;

    await this.removeEmptyConversationIfAny();

    this.error.set(null);
    this.pendingEditMessageId = null;
    this.selectedId.set(id);
    this.clearStreamingPipeline();
    this.stickToBottom = true;
    this.api.getMessages(id).subscribe({
      next: async (msgs) => {
        this.messages.set(msgs);
        await this.hub.joinConversation(id);
      },
      error: (e) => this.error.set(this.formatError(e))
    });
  }

  async stopGeneration(): Promise<void> {
    const cid = this.selectedId();
    if (!cid || !this.busyForSelected()) return;
    this.error.set(null);
    const results = await Promise.allSettled([
      firstValueFrom(this.api.cancelGeneration(cid)),
      this.hub.cancelGeneration(cid)
    ]);
    const anyOk = results.some((r) => r.status === 'fulfilled');
    if (!anyOk) {
      const reason = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => this.formatError(r.reason))
        .join('; ');
      this.error.set(reason || 'Could not cancel generation.');
    }
  }

  /**
   * Ensures a conversation exists before sending (e.g. first message from welcome with no thread yet).
   * Returns null if creation fails.
   */
  private async ensureConversationForSend(): Promise<string | null> {
    const existing = this.selectedId();
    if (existing) return existing;

    try {
      const c = await firstValueFrom(this.api.createConversation({}));
      this.conversations.update((list) => [c, ...list]);
      this.selectedId.set(c.id);
      this.messages.set([]);
      this.clearStreamingPipeline();
      this.stickToBottom = true;
      await this.hub.joinConversation(c.id);
      return c.id;
    } catch (e) {
      this.error.set(this.formatError(e));
      return null;
    }
  }

  async send(mode: 'text' | 'voice' = 'text'): Promise<void> {
    const text = this.input.trim();
    if (!text) return;

    const cid = await this.ensureConversationForSend();
    if (!cid) return;
    if (this.generatingConversationIds().has(cid)) return;

    this.error.set(null);
    this.input = '';
    this.clearStreamingPipeline();
    this.stickToBottom = true;
    this.setConversationGenerating(cid, true);

    try {
      const editId = this.pendingEditMessageId;
      this.pendingEditMessageId = null;
      if (editId) {
        await firstValueFrom(this.api.deleteMessagesFrom(cid, editId));
        this.messages.update((msgs) => {
          const i = msgs.findIndex((x) => x.id === editId);
          return i < 0 ? msgs : msgs.slice(0, i);
        });
      }

      // Optimistic user line; IDs refresh from server when the stream completes.
      this.messages.update((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'user',
          content: text,
          inputMode: mode,
          createdAt: new Date().toISOString()
        }
      ]);

      await this.hub.sendMessage(cid, text, mode);
    } catch (e) {
      this.error.set(this.formatError(e));
      this.setConversationGenerating(cid, false);
    }
  }

  copyMessage(content: string, messageId: string): void {
    void navigator.clipboard.writeText(content).then(() => {
      if (this.copyFeedbackClear !== null) clearTimeout(this.copyFeedbackClear);
      this.copyFeedbackId.set(messageId);
      this.copyFeedbackClear = setTimeout(() => {
        this.copyFeedbackId.set(null);
        this.copyFeedbackClear = null;
      }, 2000);
    });
  }

  editUserMessage(m: MessageDto): void {
    if (m.role !== 'user') return;
    this.pendingEditMessageId = m.id;
    this.input = m.content;
    this.composerInput()?.nativeElement?.focus();
  }

  /** Enter sends; Shift+Enter inserts a newline (see template on composer). */
  onComposerKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Enter') return;
    if (ev.isComposing) return;
    if (ev.shiftKey) return;
    ev.preventDefault();
    void this.send();
  }

  async deleteConversation(id: string, ev?: Event): Promise<void> {
    ev?.stopPropagation();
    if (!confirm('Delete this chat? It will be hidden from your list (soft delete).')) return;
    this.error.set(null);
    try {
      await firstValueFrom(this.api.deleteConversation(id));
    } catch (e) {
      if (!ChatComponent.isDeleteAlreadyGone(e)) {
        this.error.set(this.formatError(e));
        return;
      }
    }
    this.setConversationGenerating(id, false);
    this.conversations.update((list) => list.filter((c) => c.id !== id));
    if (this.selectedId() === id) {
      this.selectedId.set(null);
      this.messages.set([]);
      const rest = this.conversations();
      if (rest.length > 0) await this.selectConversation(rest[0].id);
    }
  }

  startVoice(): void {
    this.error.set(null);
    this.voice.startSession(
      (text) => {
        this.input = text;
      },
      (end) => {
        if (end.text.length > 0) {
          void this.send('voice');
          return;
        }
        if (end.reason === 'error') {
          this.error.set('Voice input failed. Try again or type your message.');
        }
      }
    );
  }

  stopVoice(): void {
    this.voice.stop();
  }

  logout(): void {
    this.auth.logout();
  }
}
