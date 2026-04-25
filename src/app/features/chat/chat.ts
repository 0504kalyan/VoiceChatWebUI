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
  readonly openThreadActionsId = signal<string | null>(null);
  readonly profileMenuOpen = signal(false);
  readonly selectedAttachments = signal<LocalAttachment[]>([]);

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
  private readonly maxAttachmentBytes = 10 * 1024 * 1024;
  private readonly maxAttachmentCount = 6;

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

  /** Model tag stored for the selected conversation (Gemini). */
  readonly selectedConversationModel = computed(() => {
    const id = this.selectedId();
    if (!id) return null;
    return this.conversations().find((c) => c.id === id)?.model ?? null;
  });

  /** Gemini model names configured by the API. */
  private readonly geminiModelNames = signal<string[]>([]);

  /** Options in the header dropdown: union of configured Gemini list + current thread model. */
  readonly modelSelectOptions = computed(() => {
    const set = new Set<string>(this.geminiModelNames());
    const cur = this.selectedConversationModel();
    if (cur?.startsWith('gemini-')) set.add(cur);
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
    this.loadGeminiModels();

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

  private loadGeminiModels(): void {
    this.api.getGeminiModels().subscribe({
      next: (res) => {
        const ok = res.ok !== false && !res.error;
        this.geminiModelNames.set(ok ? (res.models ?? []) : []);
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
    this.voice.stop();
  }

  async newConversation(): Promise<void> {
    await this.removeEmptyConversationIfAny();
    this.error.set(null);
    this.pendingEditMessageId = null;
    this.selectedAttachments.set([]);
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
    this.selectedAttachments.set([]);
    this.openThreadActionsId.set(null);
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
    const attachments = this.selectedAttachments();
    if (!text && attachments.length === 0) return;

    const cid = await this.ensureConversationForSend();
    if (!cid) return;
    if (this.generatingConversationIds().has(cid)) return;

    this.error.set(null);
    this.input = '';
    this.selectedAttachments.set([]);
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
      const displayText = this.buildUserDisplayContent(text, attachments);
      this.messages.update((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'user',
          content: displayText,
          inputMode: mode,
          createdAt: new Date().toISOString()
        }
      ]);

      await this.hub.sendMessage(cid, text, mode, attachments);
    } catch (e) {
      this.error.set(this.formatError(e));
      this.setConversationGenerating(cid, false);
    }
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
    if (attachments.length === 0) return text;
    const names = attachments.map((f) => `${f.fileName} (${this.formatFileSize(f.size)})`).join(', ');
    return text ? `${text}\n\nAttached files: ${names}` : `Attached files: ${names}`;
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
