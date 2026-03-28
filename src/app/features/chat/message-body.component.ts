import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { parseMessageSegments, type MessageSegment } from './message-segments';

@Component({
  selector: 'app-message-body',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './message-body.component.html',
  styleUrl: './message-body.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MessageBodyComponent {
  readonly content = input.required<string>();

  readonly segments = computed<MessageSegment[]>(() => parseMessageSegments(this.content()));

  copyText(text: string): void {
    void navigator.clipboard.writeText(text);
  }
}
