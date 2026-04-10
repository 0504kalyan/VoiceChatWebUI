import { CommonModule } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';
import { PasswordFieldComponent } from '../../../shared/password-field/password-field';

@Component({
  selector: 'app-reset-password',
  imports: [CommonModule, FormsModule, RouterLink, PasswordFieldComponent],
  templateUrl: './reset-password.html',
  styleUrl: '../login/login.scss'
})
export class ResetPasswordComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);

  email = '';
  token = '';
  password = '';
  confirmPassword = '';
  readonly missingLink = signal(false);
  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);
  readonly busy = signal(false);

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    this.token = (q.get('token') ?? '').trim();
    this.email = (q.get('email') ?? '').trim();
    if (!this.token || !this.email) {
      this.missingLink.set(true);
    }
  }

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
    if (this.password !== this.confirmPassword) {
      this.error.set('Passwords do not match.');
      return;
    }
    if (this.password.length < 8) {
      this.error.set('Password must be at least 8 characters.');
      return;
    }
    this.busy.set(true);
    try {
      const res = await firstValueFrom(
        this.auth.resetPassword(this.email, this.token, this.password)
      );
      this.success.set(res.message);
    } catch (e: unknown) {
      this.error.set(this.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
