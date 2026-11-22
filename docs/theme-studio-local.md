# Building a real theme on localhost

By default Theme Studio on a laptop runs in its offline practice mode: no
model is called, and every "theme" is the bundled Studio theme with flat
placeholder pictures. This page is how to build a real one locally, with the
real models, and what that costs.

> A theme built here lives in the LOCAL database and its pictures in the bucket
> `.env` names. There is no export to production: a theme meant for merchants
> is built in production's Theme Studio.

## What is different from production

In production three things outside the web app move a theme along: a
scheduler calls the worker route every minute (the build and the photographs),
another calls the design-review route, and a Cloud Run job opens the theme in a
browser for its checks. None of them exists on a laptop. `npm run
theme-studio:local` (`scripts/theme-studio-local.mjs`) is all three in one
terminal.

## One-time setup

1. **Settings**, in `.env.local` (never committed):

   ```bash
   THEME_STUDIO_PROVIDER=vertex-gemini
   THEME_STUDIO_CAPTURE_ENABLED=true
   THEME_STUDIO_AUTO_QA_ENABLED=true
   THEME_STUDIO_DAILY_SPEND_USD=25
   ```

   The first sends new themes to the models. The next two run the browser
   checks and the design review with its automatic repairs, as production
   does. The last stops NEW builds once an operator's estimated spend passes
   that many dollars in 24 hours; a build already running is never stopped.
   `GCP_PROJECT_ID` (already in `.env`) is the project the models bill to.

2. **Google sign-in**, when it has expired (the runner says so):

   ```bash
   gcloud auth application-default login
   ```

3. **The capture job's packages**, once:

   ```bash
   cd jobs/theme-studio-capture && npm install && cd ../..
   ```

## Every time

1. Build and start the app as production does, not the dev server:

   ```bash
   npm run build && npm run start
   ```

   A real build opens six pages of the theme at several widths, more than
   once. The dev server compiles each page on demand and, on an 8 GB machine,
   restarts itself when its memory fills, which fails the checks
   ("the preview store's measuring script did not answer"). The first live
   build lost its layout check that way on 22 Nov 2026; the same pages took 4
   to 38 seconds on the dev server and under half a second on a production
   build. Rebuild after any change to the code or to `.env.local`.

2. In a second terminal: `npm run theme-studio:local`. It checks the settings,
   the dev server and the Google sign-in first, and says what is missing.
3. Create the theme at `/dashboard/themes/studio/new` on the platform host and
   leave the runner open until the theme is ready. A full build is usually 35
   to 75 minutes.
4. Ctrl+C stops the runner. It cancels nothing: the theme waits and continues
   when the runner is started again. To stop a theme, use Stop on its page.

The runner prints one line when something happens:

```
13:43:12  build: nothing waiting. Start or change a theme in the Studio.
13:51:40  build: 1 step(s) worked on. Finished 1, failed 0, waiting to continue 0, stopped 0.
14:20:05  checks: 1 design(s) opened and measured.
14:21:10  review: a design review ran.
```

## What it costs

Nothing while no theme is waiting: the runner then makes three local requests
every half minute and calls no provider. A theme you start is charged for:

| Step                                   | Who is paid                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Plan, build, picture checks and review | Google (Gemini on Vertex), in the project `.env` names                                              |
| Photographs, up to 41 a theme          | The image provider chosen on the platform's Mink AI page: Google, or ElevenLabs when its key is set |

The Mink AI page's choice is stored in the local database, separately from
production's. With ElevenLabs, measured on 22 Nov 2026 at 1K: about 130 credits
a picture with no reference photo and about 475 (Low) to 560 (Medium) with
one; 2K was not measured and costs more.

## Things to know

- **The dev server is for the practice mode only.** `npm run dev` restarts
  itself under a real build (above), and on 22 Nov 2026 `npm run dev:turbo`
  failed to resolve a Google font (`next/font/google`, Jost) on the first
  page it compiled, after which every route answered 500.
- **A server restart in the middle of a build is survivable.** The step that
  was running is picked up again on the runner's next try; a photograph
  already asked for is collected, never drawn twice.
- **A check that failed can be run again** from the theme's Checks tab; for a
  design whose automatic checks failed, that continues the build where it
  stopped (layout check, then the photographs).
- **A check that waited over 15 minutes is failed, not run.** The runner clears
  such leftovers before its browser loop starts, so an old theme is never
  reviewed (and paid for) by surprise.
- **`--no-checks`** skips the browser; **`--origin=`** names another local
  port. The runner refuses an origin that is not this machine, because it
  sends the job secret to it.
- To go back to the free practice mode, remove the four settings (or set
  `THEME_STUDIO_PROVIDER=fake`) and restart the dev server.
