import { CommonModule } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';
import { PasswordFieldComponent } from '../../../shared/password-field/password-field';
import { isPasswordAcceptable } from '../../../shared/password-policy';

@Component({
  selector: 'app-register',
  imports: [CommonModule, FormsModule, RouterLink, PasswordFieldComponent],
  templateUrl: './register.html',
  styleUrl: '../login/login.scss'
})
export class RegisterComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly step = signal<1 | 2>(1);
  email = '';
  code = '';
  password = '';
  confirmPassword = '';
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  ngOnInit(): void {
    if (this.auth.accessToken()) {
      void this.router.navigate(['/chat']);
      return;
    }
    const err = this.route.snapshot.queryParamMap.get('error');
    if (err === 'google_not_configured') {
      this.error.set(
        'Google sign-in is not configured on the API. Set Google:ClientId and Google:ClientSecret, then restart the API.'
      );
    }
  }

  private formatError(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const body = e.error as { message?: string } | undefined;
      return body?.message ?? e.message;
    }
    return String(e);
  }

  async sendOtp(): Promise<void> {
    this.error.set(null);
    this.busy.set(true);
    try {
      await firstValueFrom(this.auth.registerSendOtp(this.email.trim()));
      this.step.set(2);
    } catch (e: unknown) {
      this.error.set(this.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }

  async complete(): Promise<void> {
    this.error.set(null);
    if (this.password !== this.confirmPassword) {
      this.error.set('Passwords do not match.');
      return;
    }
    if (!isPasswordAcceptable(this.password)) {
      this.error.set('Meet all password requirements listed below.');
      return;
    }
    this.busy.set(true);
    try {
      const res = await firstValueFrom(
        this.auth.registerComplete(this.email.trim(), this.code.trim(), this.password)
      );
      this.auth.setSession(res);
      await this.router.navigate(['/chat']);
    } catch (e: unknown) {
      this.error.set(this.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }

  google(): void {
    window.location.href = this.auth.googleLoginUrl();
  }

  passwordOk(): boolean {
    return isPasswordAcceptable(this.password);
  }
}
