import { CommonModule } from '@angular/common';
import { Component, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-password-field',
  imports: [CommonModule, FormsModule],
  templateUrl: './password-field.html',
  styleUrl: './password-field.scss'
})
export class PasswordFieldComponent {
  label = input.required<string>();
  name = input<string>('password');
  autocomplete = input<string>('current-password');
  placeholder = input<string>('');

  /** Two-way bind to the parent password string. */
  value = model<string>('');

  /** Fires when Enter is pressed inside the input (for login submit). */
  enterSubmit = output<void>();

  protected readonly visible = signal(false);

  protected toggle(): void {
    this.visible.update((v) => !v);
  }

  protected onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter') {
      this.enterSubmit.emit();
    }
  }
}
