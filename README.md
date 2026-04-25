# VoiceChatWeb

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 20.3.22.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts under `dist/` (for this app: **`dist/VoiceChat.Web/browser/`** for production). By default, the production build optimizes your application for performance and speed.

### Deploying on Vercel

Set **Output Directory** to `dist/VoiceChat.Web/browser`, or rely on [`vercel.json`](vercel.json) in this folder. If the Git repo includes multiple projects, set Vercel **Root Directory** to `WebUI/VoiceChat.Web`.

Production builds use `src/environments/environment.ts`, which currently points to `https://voicechatapi.onrender.com`. If your API origin changes, update that file before building.

On the API, allow your Vercel origin in CORS (e.g. `Cors__Origins__0` = `https://your-app.vercel.app`). See [`../../voicechat/deployment docs/vercel-and-render.md`](../../voicechat/deployment%20docs/vercel-and-render.md).

## Running unit tests

To execute unit tests with the [Karma](https://karma-runner.github.io) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
