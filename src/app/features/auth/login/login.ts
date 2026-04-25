import { CommonModule } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';
import { PasswordFieldComponent } from '../../../shared/password-field/password-field';

@Component({
  selector: 'app-login',
  imports: [CommonModule, FormsModule, RouterLink, PasswordFieldComponent],
  templateUrl: './login.html',
  styleUrl: './login.scss'
})
export class LoginComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  email = '';
  password = '';
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
        'Google sign-in is not configured on the API. Set GoogleCredentials__ClientId and GoogleCredentials__ClientSecret on the API, then add the exact authorizedRedirectUri reported by /api/auth/google/status in Google Cloud Console.'
      );
    } else if (err === 'google_claims') {
      this.error.set('Google did not return your email. Try again or use email/password.');
    } else if (err === 'gmail_only') {
      this.error.set('Only Gmail (@gmail.com) addresses are allowed.');
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
    this.busy.set(true);
    try {
      const res = await firstValueFrom(this.auth.login(this.email.trim(), this.password));
      this.auth.setSession(res);
      await this.router.navigate(['/chat']);
    } catch (e: unknown) {
      this.error.set(this.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }

  google(): void {
    globalThis.location.href = this.auth.googleLoginUrl();
  }
}
