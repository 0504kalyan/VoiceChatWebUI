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
import { ChatHubService, ChatUploadAttachment } from '../../core/services/chat-hub.service';
import { VoiceService } from '../../core/services/voice.service';
import { MessageBodyComponent } from './message-body.component';

interface LocalAttachment extends ChatUploadAttachment {
  id: string;
  size: number;
}

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
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  readonly conversations = signal<ConversationListItem[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly messages = signal<MessageDto[]>([]);
  readonly streaming = signal('');
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly openThreadActionsId = signal<string | null>(null);
  readonly profileMenuOpen = signal(false);
  readonly selectedAttachments = signal<LocalAttachment[]>([]);
  readonly imageGenerationRemainingSeconds = signal<number | null>(null);

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

  readonly chatLimitWarning = computed(() => {
    if (!this.selectedId() || this.busyForSelected()) return null;
    const remaining = this.remainingMessagesInCurrentChat();
    if (remaining <= 0) return 'This chat reached its limit. A new chat will start automatically.';
    if (remaining <= this.limitWarningThreshold) {
      const noun = remaining === 1 ? 'message' : 'messages';
      return `This chat is almost full: ${remaining} ${noun} left before a new chat starts automatically.`;
    }
    return null;
  });

  private setConversationGenerating(conversationId: string, generating: boolean): void {
    const next = new Set(this.generatingConversationIds());
    if (generating) next.add(conversationId);
    else next.delete(conversationId);
    this.generatingConversationIds.set(next);
  }

  private remainingMessagesInCurrentChat(): number {
    return Math.max(0, this.chatMessageLimit() - this.messages().length);
  }

  private isCurrentChatAtLimit(): boolean {
    return this.remainingMessagesInCurrentChat() <= 0;
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
  private imageGenerationTimer: ReturnType<typeof setInterval> | null = null;
  private imageGenerationConversationId: string | null = null;
  readonly continuingMessageId = signal<string | null>(null);
  private readonly maxAttachmentBytes = 10 * 1024 * 1024;
  private readonly maxAttachmentCount = 6;
  private readonly estimatedImageGenerationSeconds = 35;
  private readonly limitWarningThreshold = 5;
  private readonly chatMessageLimit = signal(20);
  private readonly continuationPrompt =
    'Continue from exactly where you stopped in the previous assistant response. Do not repeat content already written.';

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

  roleLabel(role: string): string {
    return role === 'assistant' ? 'ChatAI' : this.auth.displayName();
  }

  canSendMessage(): boolean {
    return (
      !this.busyForSelected() &&
      (this.input.trim().length > 0 || this.selectedAttachments().length > 0)
    );
  }

  /** Model tag stored for the selected conversation (Gemini or ollama:...). */
  readonly selectedConversationModel = computed(() => {
    const id = this.selectedId();
    if (!id) return null;
    return this.conversations().find((c) => c.id === id)?.model ?? null;
  });

  /** Gemini + Ollama model ids configured by the API. */
  private readonly geminiModelNames = signal<string[]>([]);

  /** Options in the header dropdown: union of configured list + current thread model. */
  readonly modelSelectOptions = computed(() => {
    const set = new Set<string>(this.geminiModelNames());
    const cur = this.selectedConversationModel();
    if (cur?.startsWith('gemini-')) set.add(cur);
    if (cur?.startsWith('ollama:')) set.add(cur);
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

  private startImageGenerationCountdown(conversationId: string): void {
    this.stopImageGenerationCountdown();
    this.imageGenerationConversationId = conversationId;
    this.imageGenerationRemainingSeconds.set(this.estimatedImageGenerationSeconds);
    this.imageGenerationTimer = setInterval(() => {
      this.imageGenerationRemainingSeconds.update((remaining) => {
        if (remaining === null) return null;
        return Math.max(0, remaining - 1);
      });
    }, 1000);
  }

  private stopImageGenerationCountdown(conversationId?: string): void {
    if (conversationId && this.imageGenerationConversationId !== conversationId) return;
    if (this.imageGenerationTimer !== null) {
      clearInterval(this.imageGenerationTimer);
      this.imageGenerationTimer = null;
    }
    this.imageGenerationConversationId = null;
    this.imageGenerationRemainingSeconds.set(null);
  }

  imageGenerationStatusText(): string {
    const remaining = this.imageGenerationRemainingSeconds();
    if (remaining === null) return 'Generating image...';
    if (remaining <= 0) return 'Finishing image...';
    return `Generating image... about ${remaining}s remaining`;
  }

  isImageGenerationForSelected(): boolean {
    return this.imageGenerationConversationId === this.selectedId() && this.imageGenerationRemainingSeconds() !== null;
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
    this.loadGeminiModels();

    await this.hub.start({
      onToken: (cid, token) => {
        if (cid !== this.selectedId()) return;
        this.stopImageGenerationCountdown(cid);
        const continuingId = this.continuingMessageId();
        if (continuingId) {
          this.messages.update((msgs) =>
            msgs.map((m) => (m.id === continuingId ? { ...m, content: m.content + token } : m))
          );
          return;
        }
        this.streamTokenBuffer += token;
        this.scheduleStreamFlush();
      },
      onComplete: (cid) => {
        this.setConversationGenerating(cid, false);
        this.stopImageGenerationCountdown(cid);
        this.continuingMessageId.set(null);
        this.refreshConversationList();
        if (cid !== this.selectedId()) return;
        this.finalizeStreamingBuffer();
        this.streaming.set('');
        // Sync from server so message IDs match DB (needed for edit / delete-from).
        this.api.getMessages(cid).subscribe({
          next: (msgs) => {
            this.messages.set(msgs);
            void this.startNewChatIfLimitReached();
          },
          error: (e) => this.error.set(this.formatError(e))
        });
      },
      onError: (cid, message) => {
        this.setConversationGenerating(cid, false);
        this.stopImageGenerationCountdown(cid);
        this.continuingMessageId.set(null);
        if (cid !== this.selectedId()) return;
        this.finalizeStreamingBuffer();
        this.error.set(message);
        this.streaming.set('');
      },
      onCancelled: (cid) => {
        this.setConversationGenerating(cid, false);
        this.stopImageGenerationCountdown(cid);
        this.continuingMessageId.set(null);
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

  private async startNewChatIfLimitReached(): Promise<void> {
    if (!this.selectedId() || !this.isCurrentChatAtLimit()) return;
    await this.createAndSelectConversation('Chat limit reached. A new chat was started automatically.');
  }

  private loadGeminiModels(): void {
    this.api.getGeminiModels().subscribe({
      next: (res) => {
        const ok = res.ok !== false && !res.error;
        this.geminiModelNames.set(ok ? (res.models ?? []) : []);
        if (ok && typeof res.maxHistoryMessages === 'number' && res.maxHistoryMessages >= 4) {
          this.chatMessageLimit.set(res.maxHistoryMessages);
        }
      },
      error: () => this.geminiModelNames.set([])
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
    this.continuingMessageId.set(null);
    this.stopImageGenerationCountdown();
    this.voice.stop();
  }

  private async createAndSelectConversation(notice?: string): Promise<string | null> {
    try {
      const c = await firstValueFrom(this.api.createConversation({}));
      this.conversations.update((list) => [c, ...list]);
      this.selectedId.set(c.id);
      this.messages.set([]);
      this.clearStreamingPipeline();
      this.stickToBottom = true;
      this.pendingEditMessageId = null;
      this.selectedAttachments.set([]);
      await this.hub.joinConversation(c.id);
      if (notice) this.notice.set(notice);
      return c.id;
    } catch (e) {
      this.error.set(this.formatError(e));
      return null;
    }
  }

  async newConversation(): Promise<void> {
    await this.removeEmptyConversationIfAny();
    this.error.set(null);
    this.notice.set(null);
    this.pendingEditMessageId = null;
    this.selectedAttachments.set([]);
    await this.createAndSelectConversation();
  }

  async selectConversation(id: string): Promise<void> {
    if (id === this.selectedId()) return;

    await this.removeEmptyConversationIfAny();

    this.error.set(null);
    this.notice.set(null);
    this.pendingEditMessageId = null;
    this.selectedAttachments.set([]);
    this.openThreadActionsId.set(null);
    this.continuingMessageId.set(null);
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
  private async ensureConversationForSend(forceCurrentChat = false): Promise<string | null> {
    const existing = this.selectedId();
    if (existing && (forceCurrentChat || !this.isCurrentChatAtLimit())) return existing;

    if (existing && this.isCurrentChatAtLimit()) {
      return this.createAndSelectConversation('Previous chat reached its limit, so a new chat was started automatically.');
    }

    return this.createAndSelectConversation();
  }

  async send(mode: 'text' | 'voice' | 'continue' = 'text', forceCurrentChat = false): Promise<void> {
    const text = this.input.trim();
    const attachments = this.selectedAttachments();
    if (!text && attachments.length === 0) return;
    const isContinuation = mode === 'continue';

    const cid = await this.ensureConversationForSend(forceCurrentChat);
    if (!cid) return;
    if (this.generatingConversationIds().has(cid)) return;

    this.error.set(null);
    this.notice.set(null);
    this.input = '';
    this.selectedAttachments.set([]);
    if (!isContinuation) this.clearStreamingPipeline();
    this.stickToBottom = true;
    this.setConversationGenerating(cid, true);
    if (!isContinuation && this.isImageGenerationRequest(text, attachments)) {
      this.startImageGenerationCountdown(cid);
    }

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

      if (!isContinuation) {
        // Optimistic user line; IDs refresh from server when the stream completes.
        const displayText = this.buildUserDisplayContent(text, attachments);
        this.messages.update((m) => [
          ...m,
          {
            id: crypto.randomUUID(),
            role: 'user',
            content: displayText,
            inputMode: mode,
            createdAt: new Date().toISOString(),
            isGenerationComplete: true
          }
        ]);
      }

      await this.hub.sendMessage(cid, text, mode, attachments);
    } catch (e) {
      this.error.set(this.formatError(e));
      this.setConversationGenerating(cid, false);
      this.continuingMessageId.set(null);
      this.stopImageGenerationCountdown(cid);
    }
  }

  canContinueFromMessage(message: MessageDto, index: number): boolean {
    return (
      message.role === 'assistant' &&
      message.isGenerationComplete === false &&
      index === this.messages().length - 1 &&
      !this.busyForSelected()
    );
  }

  continueGeneration(): void {
    if (!this.selectedId() || this.busyForSelected()) return;
    const target = this.messages().at(-1);
    if (target?.role !== 'assistant' || target.isGenerationComplete !== false) return;
    this.continuingMessageId.set(target.id);
    this.input = this.continuationPrompt;
    this.selectedAttachments.set([]);
    void this.send('continue', true);
  }

  private isImageGenerationRequest(text: string, attachments: LocalAttachment[]): boolean {
    const prompt = text.toLowerCase();
    const wantsImageOutput =
      prompt.includes('create image') ||
      prompt.includes('create an image') ||
      prompt.includes('generate image') ||
      prompt.includes('generate an image') ||
      prompt.includes('make an image') ||
      prompt.includes('design an image') ||
      prompt.includes('draw ') ||
      prompt.includes('enhance') ||
      prompt.includes('upscale') ||
      prompt.includes('restore image') ||
      prompt.includes('improve this image') ||
      prompt.includes('return the same image');

    const hasImageAttachment = attachments.some((a) => a.contentType.startsWith('image/'));
    return wantsImageOutput && (hasImageAttachment || prompt.includes('image') || prompt.includes('picture') || prompt.includes('photo'));
  }

  triggerFilePicker(): void {
    this.fileInput()?.nativeElement.click();
  }

  async onFilesSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length === 0) return;

    const current = this.selectedAttachments();
    const slots = this.maxAttachmentCount - current.length;
    if (slots <= 0) {
      this.error.set(`You can attach up to ${this.maxAttachmentCount} files per message.`);
      return;
    }

    const next: LocalAttachment[] = [];
    for (const file of files.slice(0, slots)) {
      if (file.size > this.maxAttachmentBytes) {
        this.error.set(`${file.name} is too large. Max size is ${this.formatFileSize(this.maxAttachmentBytes)}.`);
        continue;
      }
      next.push(await this.fileToAttachment(file));
    }

    if (next.length > 0) {
      this.error.set(null);
      this.selectedAttachments.set([...current, ...next]);
    }
  }

  removeAttachment(id: string): void {
    this.selectedAttachments.update((files) => files.filter((f) => f.id !== id));
  }

  formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private async fileToAttachment(file: File): Promise<LocalAttachment> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('Could not read file.'));
      reader.readAsDataURL(file);
    });
    const base64Data = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    return {
      id: crypto.randomUUID(),
      fileName: file.name,
      contentType: file.type || 'application/octet-stream',
      base64Data,
      size: file.size
    };
  }

  private buildUserDisplayContent(text: string, attachments: LocalAttachment[]): string {
    if (text === this.continuationPrompt) return 'Continue';
    if (attachments.length === 0) return text;
    const countText = attachments.length === 1 ? '1 file attached' : `${attachments.length} files attached`;
    return text ? `${text}\n\n${countText}` : countText;
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

  async deleteConversation(id: string, ev?: Event, confirmMessage = 'Delete this chat? It will be hidden from your list.'): Promise<void> {
    ev?.stopPropagation();
    if (!confirm(confirmMessage)) return;
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

  toggleThreadActions(id: string, ev: Event): void {
    ev.stopPropagation();
    this.openThreadActionsId.set(this.openThreadActionsId() === id ? null : id);
  }

  renameConversation(id: string, ev?: Event): void {
    ev?.stopPropagation();
    this.openThreadActionsId.set(null);
    const currentConversation = this.conversations().find((c) => c.id === id);
    const current = currentConversation ? this.displayThreadTitle(currentConversation) : '';
    const defaultValue = current === 'New chat' ? '' : current;
    const title = prompt('Rename chat', defaultValue);
    if (title === null) return;

    this.api.patchConversation(id, { title }).subscribe({
      next: (dto) => {
        this.conversations.update((list) =>
          list.map((c) => (c.id === id ? { ...c, title: dto.title, updatedAt: dto.updatedAt } : c))
        );
      },
      error: (e) => this.error.set(this.formatError(e))
    });
  }

  async archiveConversation(id: string, ev?: Event): Promise<void> {
    ev?.stopPropagation();
    this.openThreadActionsId.set(null);
    await this.deleteConversation(id, undefined, 'Archive this chat? It will be hidden from your chat list.');
  }

  async deleteConversationFromMenu(id: string, ev?: Event): Promise<void> {
    ev?.stopPropagation();
    this.openThreadActionsId.set(null);
    await this.deleteConversation(id);
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
    this.profileMenuOpen.set(false);
    this.auth.logout();
  }

  openSettings(): void {
    this.profileMenuOpen.set(false);
    alert('Settings panel is coming soon.');
  }
}
