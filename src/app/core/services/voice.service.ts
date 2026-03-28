import { Injectable, signal } from '@angular/core';

type RecognitionCtor = new () => WebSpeechRecognition;

interface WebSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: WebSpeechRecognitionEvent) => void) | null;
  onerror: ((ev: WebSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
}

interface WebSpeechRecognitionEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
}

interface WebSpeechRecognitionErrorEvent {
  error: string;
}

/** Fired when the session ends: silence timeout, manual stop, or error. */
export interface VoiceSessionEnd {
  reason: 'silence' | 'manual' | 'error';
  /** Best-effort transcript (trimmed). */
  text: string;
}

@Injectable({ providedIn: 'root' })
export class VoiceService {
  readonly listening = signal(false);
  /** True once non-empty speech was recognized in the current session (for UI). */
  readonly speechDetected = signal(false);
  readonly supported = signal(false);

  private recognition?: WebSpeechRecognition;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private latestTranscript = '';
  private sessionEnded = false;
  private onTranscript?: (text: string) => void;
  private onSessionEnd?: (end: VoiceSessionEnd) => void;

  /** No speech / recognition activity for this long → hide mic and submit (if any text). */
  private readonly silenceMs = 2000;

  /** If the user never speaks after opening the mic, close after this many ms. */
  private readonly idleBeforeSpeechMs = 3000;

  constructor() {
    const w = window as unknown as {
      webkitSpeechRecognition?: RecognitionCtor;
      SpeechRecognition?: RecognitionCtor;
    };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    this.supported.set(!!SR);
    if (SR) {
      this.recognition = new SR();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = navigator.language || 'en-US';
    }
  }

  /**
   * Starts a voice session: continuous recognition.
   * After the last speech result, if there is **{@link silenceMs} ms** of silence, the session ends (UI hides).
   * If {@link VoiceSessionEnd.text} is non-empty, treat as a completed voice command (e.g. send to chat).
   */
  startSession(
    onTranscript: (text: string) => void,
    onSessionEnd: (end: VoiceSessionEnd) => void
  ): void {
    if (!this.recognition) {
      onSessionEnd({ reason: 'error', text: '' });
      return;
    }

    this.clearSilenceTimer();
    this.latestTranscript = '';
    this.sessionEnded = false;
    this.onTranscript = onTranscript;
    this.onSessionEnd = onSessionEnd;
    this.speechDetected.set(false);

    this.recognition.onresult = (ev: WebSpeechRecognitionEvent) => {
      if (this.sessionEnded) return;

      let full = '';
      for (let i = 0; i < ev.results.length; i++) {
        full += ev.results[i][0].transcript;
      }
      const text = full.trim();
      if (text.length > 0) {
        this.speechDetected.set(true);
        this.latestTranscript = text;
        this.onTranscript?.(text);
        // Countdown only after last recognition update; extended while user keeps talking.
        this.resetSilenceTimer();
      }
    };

    this.recognition.onerror = (ev: WebSpeechRecognitionErrorEvent) => {
      if (this.sessionEnded) return;
      // `no-speech` is common while waiting; our silence timer handles end-of-utterance.
      if (ev.error === 'no-speech' || ev.error === 'aborted') {
        return;
      }
      this.finishSession('error', this.latestTranscript.trim());
    };

    this.recognition.onend = () => {
      if (this.sessionEnded) {
        this.listening.set(false);
        this.clearSilenceTimer();
        return;
      }
      // Browsers often stop recognition after each phrase even with continuous: true; restart so the mic stays up while the user is still talking.
      setTimeout(() => {
        if (this.sessionEnded) return;
        try {
          this.recognition?.start();
        } catch {
          /* InvalidStateError: already running — ignore */
        }
      }, 0);
    };

    this.recognition.onspeechstart = () => {
      if (this.sessionEnded) return;
      this.speechDetected.set(true);
      this.clearSilenceTimer();
    };

    this.recognition.onspeechend = () => {
      /* Do not start the silence timer here — it often fires between words. Use last onresult + silenceMs. */
    };

    try {
      this.listening.set(true);
      this.recognition.start();
    } catch {
      this.listening.set(false);
      onSessionEnd({ reason: 'error', text: '' });
    }
  }

  /** Stops recognition and ends the session with reason `manual`. */
  stop(): void {
    this.finishSession('manual', this.latestTranscript.trim());
  }

  private resetSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.finishSession('silence', this.latestTranscript.trim());
    }, this.silenceMs);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private finishSession(reason: VoiceSessionEnd['reason'], text: string): void {
    if (this.sessionEnded) return;
    this.sessionEnded = true;
    this.clearSilenceTimer();

    try {
      this.recognition?.stop();
    } catch {
      try {
        this.recognition?.abort();
      } catch {
        /* ignore */
      }
    }

    this.listening.set(false);
    this.speechDetected.set(false);
    const end: VoiceSessionEnd = { reason, text };
    const cb = this.onSessionEnd;
    this.onTranscript = undefined;
    this.onSessionEnd = undefined;
    cb?.(end);
  }
}
