import { CommonModule } from '@angular/common';
import { Component, inject, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-google-callback',
  imports: [CommonModule],
  template: `<div class="auth-page"><div class="card"><p>Signing you in…</p></div></div>`,
  styleUrl: './login/login.scss'
})
export class GoogleCallbackComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  ngOnInit(): void {
    const token = this.route.snapshot.queryParamMap.get('token');
    const err = this.route.snapshot.queryParamMap.get('error');
    if (err) {
      void this.router.navigate(['/login'], { queryParams: { error: err } });
      return;
    }
    if (!token) {
      void this.router.navigate(['/login'], { queryParams: { error: 'missing_token' } });
      return;
    }
    this.auth.storeAccessToken(token);
    void this.router.navigate(['/chat']);
  }
}
