import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  OnDestroy,
  signal
} from '@angular/core';
import { parseMessageSegments, type MessageSegment } from './message-segments';

@Component({
  selector: 'app-message-body',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './message-body.component.html',
  styleUrl: './message-body.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MessageBodyComponent implements OnDestroy {
  readonly content = input.required<string>();

  readonly segments = computed<MessageSegment[]>(() => parseMessageSegments(this.content()));

  /** Index into `segments()` whose copy button shows "Copied". */
  readonly copiedSegmentIndex = signal<number | null>(null);
  private copyFeedbackClear: ReturnType<typeof setTimeout> | null = null;

  ngOnDestroy(): void {
    if (this.copyFeedbackClear !== null) clearTimeout(this.copyFeedbackClear);
  }

  copySegment(text: string, segmentIndex: number): void {
    void navigator.clipboard.writeText(text).then(() => {
      if (this.copyFeedbackClear !== null) clearTimeout(this.copyFeedbackClear);
      this.copiedSegmentIndex.set(segmentIndex);
      this.copyFeedbackClear = setTimeout(() => {
        this.copiedSegmentIndex.set(null);
        this.copyFeedbackClear = null;
      }, 2000);
    });
  }
}
