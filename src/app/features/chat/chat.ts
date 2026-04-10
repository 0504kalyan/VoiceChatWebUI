import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
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
  styleUrl: './chat.scss'
})
export class ChatComponent implements OnInit, OnDestroy {
  private readonly api = inject(ChatApiService);
  private readonly hub = inject(ChatHubService);
  private readonly voice = inject(VoiceService);
  readonly auth = inject(AuthService);

  private readonly messagesScroll = viewChild<ElementRef<HTMLElement>>('messagesScroll');
  private readonly composerInput = viewChild<ElementRef<HTMLInputElement>>('composerInput');

  readonly conversations = signal<ConversationListItem[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly messages = signal<MessageDto[]>([]);
  readonly streaming = signal('');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly voiceSupported = this.voice.supported;
  readonly listening = this.voice.listening;
  readonly speechDetected = this.voice.speechDetected;

  /** While waiting for the first token from the assistant. */
  readonly thinking = computed(() => this.busy() && this.streaming().length === 0);

  /** Friendly empty state before the first message (including when no conversation exists yet). */
  readonly showWelcome = computed(
    () => this.messages().length === 0 && !this.streaming() && !this.busy()
  );

  input = '';
  /** When set, sending will truncate the thread from this user message and resend. */
  pendingEditMessageId: string | null = null;

  /** Message id (or `__streaming__`) that recently copied — shows “Copied” on the matching button. */
  readonly copyFeedbackId = signal<string | null>(null);
  private copyFeedbackClear: ReturnType<typeof setTimeout> | null = null;

  readonly title = computed(() => {
    const id = this.selectedId();
    if (!id) return 'VoiceChat';
    const c = this.conversations().find((x) => x.id === id);
    return c?.title || 'New chat';
  });

  constructor() {
    effect(() => {
      this.messages();
      this.streaming();
      untracked(() => {
        queueMicrotask(() => this.scrollMessagesToEnd());
      });
    });
  }

  private scrollMessagesToEnd(): void {
    const el = this.messagesScroll()?.nativeElement;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
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
    await this.hub.start({
      onToken: (cid, token) => {
        if (cid === this.selectedId()) this.streaming.update((s) => s + token);
      },
      onComplete: (cid) => {
        if (cid !== this.selectedId()) return;
        this.streaming.set('');
        this.busy.set(false);
        // Sync from server so message IDs match DB (needed for edit / delete-from).
        this.api.getMessages(cid).subscribe({
          next: (msgs) => this.messages.set(msgs),
          error: (e) => this.error.set(this.formatError(e))
        });
      },
      onError: (cid, message) => {
        if (cid === this.selectedId()) {
          this.error.set(message);
          this.busy.set(false);
          this.streaming.set('');
        }
      },
      onCancelled: (cid) => {
        if (cid !== this.selectedId()) return;
        this.streaming.set('');
        this.busy.set(false);
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

  ngOnDestroy(): void {
    if (this.copyFeedbackClear !== null) clearTimeout(this.copyFeedbackClear);
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
    this.streaming.set('');
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
    if (!cid || !this.busy()) return;
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

  /** Ensures a conversation exists; creates one when the user sends their first message. */
  private async ensureConversationForSend(): Promise<string | null> {
    let cid = this.selectedId();
    if (cid) return cid;
    try {
      const c = await firstValueFrom(this.api.createConversation({}));
      this.conversations.update((x) => [c, ...x]);
      this.selectedId.set(c.id);
      this.messages.set([]);
      await this.hub.joinConversation(c.id);
      return c.id;
    } catch (e) {
      this.error.set(this.formatError(e));
      return null;
    }
  }

  async send(mode: 'text' | 'voice' = 'text'): Promise<void> {
    const text = this.input.trim();
    if (!text || this.busy()) return;

    const cid = await this.ensureConversationForSend();
    if (!cid) return;

    this.error.set(null);
    this.input = '';
    this.busy.set(true);

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
      this.busy.set(false);
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
