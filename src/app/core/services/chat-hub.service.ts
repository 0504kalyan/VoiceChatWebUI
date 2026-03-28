import { Injectable } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ChatHubService {
  private hub?: signalR.HubConnection;
  private readonly base = environment.apiBaseUrl;

  get connectionState(): signalR.HubConnectionState | undefined {
    return this.hub?.state;
  }

  async start(
    handlers: {
      onToken: (conversationId: string, token: string) => void;
      onComplete: (conversationId: string) => void;
      onError: (conversationId: string, message: string) => void;
      onCancelled?: (conversationId: string) => void;
    }
  ): Promise<void> {
    if (!this.hub) {
      this.hub = new signalR.HubConnectionBuilder()
        .withUrl(`${this.base}/hubs/chat`)
        .withAutomaticReconnect()
        .build();
    }

    this.hub.off('ReceiveToken');
    this.hub.off('ReceiveComplete');
    this.hub.off('ReceiveError');
    this.hub.off('ReceiveCancelled');

    this.hub.on('ReceiveToken', handlers.onToken);
    this.hub.on('ReceiveComplete', handlers.onComplete);
    this.hub.on('ReceiveError', handlers.onError);
    this.hub.on('ReceiveCancelled', (conversationId: string) => {
      handlers.onCancelled?.(conversationId);
    });

    if (this.hub.state === signalR.HubConnectionState.Disconnected) {
      await this.hub.start();
    }
  }

  async joinConversation(conversationId: string): Promise<void> {
    await this.ensureConnected();
    await this.hub!.invoke('JoinConversation', conversationId);
  }

  async sendMessage(conversationId: string, content: string, inputMode: 'text' | 'voice'): Promise<void> {
    await this.ensureConnected();
    await this.hub!.invoke('SendMessage', conversationId, content, inputMode);
  }

  async cancelGeneration(conversationId: string): Promise<void> {
    await this.ensureConnected();
    await this.hub!.invoke('cancelGeneration', conversationId);
  }

  private async ensureConnected(): Promise<void> {
    if (!this.hub) throw new Error('Hub not configured. Call start() first.');
    if (this.hub.state === signalR.HubConnectionState.Connected) return;
    await this.hub.start();
  }
}
