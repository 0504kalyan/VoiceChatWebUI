import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';

@Component({
  selector: 'app-forgot-password',
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './forgot-password.html',
  styleUrl: '../login/login.scss'
})
export class ForgotPasswordComponent {
  private readonly auth = inject(AuthService);

  email = '';
  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);
  readonly busy = signal(false);

  private formatError(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const body = e.error as { message?: string } | undefined;
      return body?.message ?? e.message;
    }
    return String(e);
  }

  async submit(): Promise<void> {
    this.error.set(null);
    this.success.set(null);
    this.busy.set(true);
    try {
      const res = await firstValueFrom(this.auth.forgotPassword(this.email.trim()));
      this.success.set(res.message);
    } catch (e: unknown) {
      this.error.set(this.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
