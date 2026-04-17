---
name: work-with-pro
description: Use when the user says "work with pro" or wants a repo task delegated to ChatGPT Pro through review-gpt, or when they want Codex to wait on an existing ChatGPT conversation URL, download a returned patch, and resume the current session to implement it.
---

# Work With Pro

Use this skill when the user wants ChatGPT Pro to do a meaningful chunk of repo work and then wants Codex to pull down the returned patch and finish the implementation locally.

There are three distinct modes:

- `send-and-wake`: send a new or updated prompt into ChatGPT, then start the polling wake flow.
- `watch-only`: do not post anything new; just poll an already-running thread, download any returned patch, and resume Codex.
- `nudge-existing-thread`: send a brief follow-up into an existing ChatGPT thread that has already been started elsewhere, then start or continue the polling wake flow. This mode requires explicit user permission to message the existing thread.

When the user provides only an existing ChatGPT conversation URL plus instructions like "wait on this thread", "check back later", or "implement the patch when it returns", default to `watch-only`. Do not send an extra prompt unless the user explicitly asks for that, or unless they also provide new task details that need to be posted.

Important interpretation rule:

- In `watch-only`, phrases like "implement the patch", "apply it when it returns", or "use the returned patch" mean "apply the attachment locally after it exists". They do not mean "send a follow-up asking for a patch".
- Missing or delayed attachments are a stop condition in `watch-only`, not permission to post a nudge.
- If the thread only contains prose, partial progress updates, or "I'll package the diff" style messages, report that status and ask whether the user wants to keep waiting or explicitly nudge the thread.

## Polling Defaults

- Default to immediate polling with `--delay 0s`.
- Keep `--poll-interval 1m` unless the user asks for something else.
- Default to a long polling window with `--poll-timeout 120m` unless the user asks for a different bound or explicitly wants an unbounded wait.
- Use a nonzero `--delay` only when the user explicitly asks to wait before the first check.
- If the user gives an explicit delay, use it and still keep polling enabled unless they explicitly want the old one-shot behavior.
- Once a wake flow is armed, do not manually stop it just because the thread is still busy or progress looks slow. These Pro runs can reasonably take up to 120 minutes. Let the watcher keep polling until it completes, reaches the explicit timeout, fails concretely, or the user redirects you.
- Default to the normal child-resume behavior after patch download. Add `--skip-resume true` only when the user explicitly asks for download-only behavior, asks you not to spawn the child Codex run, or asks you to keep the wake flow in the current session without auto-resume.

## Preconditions

- Prefer the repo's existing `pnpm review:gpt` script.
- The repo must already have `@cobuild/review-gpt` installed so `pnpm exec cobuild-review-gpt thread wake ...` works.
- The managed ChatGPT browser session must already be signed in.
- `CODEX_THREAD_ID` must be available before scheduling the wake step.
- The user must provide the ChatGPT conversation URL that should be revisited later.

If any of those are missing, say so plainly instead of guessing.

## Workflow

### Watch-only

Use this when the existing thread already contains the task and the user only wants Codex to wait for the result.

1. Confirm the user supplied the ChatGPT conversation URL.
2. Do not call `pnpm review:gpt --send`.
   - Do not build or send any new prompt.
   - Do not ask Pro to return a patch attachment.
   - Do not post clarifications, reminders, or nudges into the thread.
3. Start the polling wake flow directly:
   - `pnpm exec cobuild-review-gpt thread wake --delay 0s --poll-interval 1m --poll-timeout 120m --chat-url <url> --session-id "$CODEX_THREAD_ID"`
   - If the user explicitly asked for a later first check, replace `--delay 0s` with that delay and keep polling enabled.
   - If the user explicitly asked to keep waiting, prefer a long-lived bound like `--poll-timeout 120m` over stopping the watcher manually after a few cycles.
   - Do not add `--skip-resume true` in the normal path. Watch-only still means "wait for the returned patch and let wake resume Codex automatically" unless the user explicitly asks for download-only handling.
   - That command is the whole wake-thread setup. Do not invent extra wrapper steps unless the local tool environment requires a specific way to keep a long-lived process alive.
   - In tool-managed terminals, prefer a persistent exec/PTTY session over an unverified shell background job so the wake process stays alive while polling.
   - Confirm the setup actually armed using whatever signal this environment exposes. Prefer structured wake output or initial log lines that include the chat URL, session ID, polling interval, and whether the initial check is immediate. If those do not surface, verify that a `cobuild-review-gpt thread wake` process is still running with the expected chat URL and session ID in its command line.
   - If the thread remains busy but already shows older patch attachments, leave the watcher running. Do not manually stop the polling session or manually land an older patch unless the user explicitly changes the plan.
4. When the wake command resumes the session, read the exported thread and inspect any downloaded patch or diff files.
5. If a `.patch`, `.diff`, or equivalent attachment exists, implement the returned changes and run the repo-required checks.
6. If the wake command exits because the thread completed or timed out and no attachment exists, report what the thread currently contains and ask the user whether to:
   - keep waiting
   - explicitly nudge the existing thread
   - abandon the Pro path and proceed another way

### Nudge-existing-thread

Use this only when the user explicitly asks you to send a follow-up message into an existing ChatGPT thread.

1. Confirm the user supplied the ChatGPT conversation URL.
2. Confirm the user explicitly wants a message posted to that existing thread. Do not infer this from "implement the patch" or similar wording.
3. Send only the smallest follow-up needed to unblock the thread, ideally one short instruction asking for the promised attachment or a specific missing detail.
   - If you are asking Pro to review completed local changes, attach files for the exact slice under review instead of sending a prose-only follow-up.
4. After sending the nudge, schedule or continue the polling wake flow and wait for the returned attachment before implementing anything locally.
5. If automation reports a browser or commit-timeout issue, treat that as unconfirmed delivery. Re-check the visible thread state before assuming the nudge was sent successfully.

### Send-and-wake

Use this when the user wants you to delegate new work or explicitly wants a follow-up prompt sent into the ChatGPT thread.

1. Default to immediate polling and only pick a nonzero delay if the user explicitly wants one.
2. Build a prompt for Pro that asks for:
   - the requested implementation
   - a `.patch` or `.diff` attachment, not just prose
   - scoped, compilable changes
   - explicit assumptions when needed
   - when reviewing completed work, attached files for the exact changed slice instead of a prose-only summary
3. Launch the review with the repo-local script:
   - `pnpm review:gpt --send ...`
4. Use the ChatGPT conversation URL provided by the user.
   - do not guess the URL
   - if the user has not provided it yet, ask for it before scheduling the wake step
5. Start the polling wake flow:
   - `pnpm exec cobuild-review-gpt thread wake --delay 0s --poll-interval 1m --poll-timeout 120m --chat-url <url> --session-id "$CODEX_THREAD_ID"`
   - If the user explicitly asked for a later first check, replace `--delay 0s` with that delay and keep polling enabled.
   - Do not add `--skip-resume true` unless the user explicitly asked for download-only behavior or explicitly asked you not to spawn the child Codex run.
   - That command is the whole wake-thread setup. Do not add extra orchestration unless the local tool environment needs a specific persistent-process mechanism.
   - In tool-managed terminals, prefer a persistent exec/PTTY session over an unverified shell background job.
   - Confirm the setup actually armed using whatever signal this environment exposes. Prefer structured wake output or initial log lines that include the chat URL, session ID, polling interval, and whether the initial check is immediate. If those do not surface, verify that a `cobuild-review-gpt thread wake` process is still running with the expected chat URL and session ID in its command line.
   - After the wake flow is armed, do not manually interrupt it just because polling is taking a while. Let the command run until completion, timeout, concrete failure, or an explicit user redirect.
6. When the wake command resumes the session, read the exported thread, inspect the downloaded patch or diff files, implement the returned changes, and run the repo-required checks.

## Prompt Requirements

Ask Pro to return an attachment-based patch. Use wording close to this:

```text
Implement this task and return the result as a .patch or .diff attachment that can be applied locally.
Keep the patch scoped to the requested work, include any needed tests, and note assumptions briefly in the response.
```

Add the repo-specific task details after that.

Use this template only in `send-and-wake`, not in `watch-only`.
In `nudge-existing-thread`, send a minimal follow-up tailored to the missing artifact rather than reusing the full send-and-wake prompt.

When asking Pro to review or audit completed local work:

- Attach files by default.
- Use the repo's normal file-attached `review:gpt` flow.
- If the worktree is dirty or the review is intentionally narrow, attach only the exact changed files or a scoped patch for the slice under review.

## Commands

Start the Pro run with the repo's review command. Example shape:

```bash
pnpm review:gpt --send --prompt "Implement this task and return the result as a .patch or .diff attachment that can be applied locally. Keep the patch scoped, include needed tests, and note assumptions briefly. <task details>"
```

For review of completed work, prefer a file-attached invocation so Pro can inspect the actual changed files.

Start the polling wake flow:

```bash
pnpm exec cobuild-review-gpt thread wake \
  --delay 0s \
  --poll-interval 1m \
  --poll-timeout 120m \
  --chat-url https://chatgpt.com/c/<thread-id> \
  --session-id "$CODEX_THREAD_ID"
```

If the environment uses managed exec sessions, keep this command attached to a long-lived session and let it run through completion or the explicit timeout. The wake implementation may log `Sleeping for ...` when a nonzero delay was explicitly requested, but the default path should check immediately and poll every minute. If the banner is absent, verify the wake another way: a still-running wake process with the expected chat URL/session ID, plus later exported-thread/download artifacts as polling progresses. If a shell-launched background job exits immediately, treat that as a failed setup and rerun the exact wake command in a persistent session. Do not manually stop a healthy wake session early just because the thread remains busy.

Use `--skip-resume true` only when the user explicitly asks for that download-only behavior. It is not the default just because the repo is dirty, the patch may need manual merging, or multiple wake flows are running.

## Notes

- Do not use removed standalone binaries like `cobuild-review-gpt-thread-wake`.
- Always go through the main incur CLI: `cobuild-review-gpt thread ...`
- If the user asks for a different model or tighter instructions, keep the same wake flow and only change the review prompt or normal `review:gpt` options.
- A provided ChatGPT thread URL by itself is not permission to post a follow-up message. Treat it as `watch-only` unless the user clearly asks you to send or update the prompt.
- When an existing thread has not produced the promised attachment yet, default to reporting the current status and asking before nudging. Do not silently convert `watch-only` into `nudge-existing-thread`.
- Process-lifetime handling is environment-specific; the wake command itself is not. Separate "what command should run" from "how this terminal keeps that process alive."
