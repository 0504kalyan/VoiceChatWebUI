import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';

export interface ConversationListItem {
  id: string;
  title: string | null;
  model: string;
  updatedAt: string;
}

export interface MessageDto {
  id: string;
  role: string;
  content: string;
  inputMode: string;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class ChatApiService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl;

  listConversations() {
    return this.http.get<ConversationListItem[]>(`${this.base}/api/conversations`);
  }

  createConversation(body?: { title?: string; model?: string }) {
    return this.http.post<ConversationListItem>(`${this.base}/api/conversations`, body ?? {});
  }

  getMessages(conversationId: string) {
    return this.http.get<MessageDto[]>(`${this.base}/api/conversations/${conversationId}/messages`);
  }

  deleteConversation(id: string) {
    return this.http.delete(`${this.base}/api/conversations/${id}`);
  }

  /** Remove a user message and everything after it (for edit + resend). */
  deleteMessagesFrom(conversationId: string, messageId: string) {
    return this.http.delete(`${this.base}/api/conversations/${conversationId}/messages/${messageId}`);
  }

  /** Cancels streaming LLM generation (same effect as SignalR cancelGeneration). */
  cancelGeneration(conversationId: string) {
    return this.http.post<void>(`${this.base}/api/conversations/${conversationId}/cancel-generation`, {});
  }

  /** Stored request + response pairs (text + JSON columns) for a conversation. */
  getResponseArchives(conversationId: string) {
    return this.http.get<
      {
        id: string;
        userRequest: string;
        responseText: string;
        responseJson: string;
        createdAt: string;
      }[]
    >(`${this.base}/api/conversations/${conversationId}/response-archives`);
  }
}
