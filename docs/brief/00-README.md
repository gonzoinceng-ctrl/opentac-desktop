# OpenTac — Build Pack for Claude Code

This pack is a complete, self-contained brief for building a production-ready
macOS desktop application that wraps the open-source project
**https://github.com/bilawalsidhu/gods-eye-view** in Electron, and that keeps
itself current by pulling updates directly from that GitHub repository.

Read the files in order. Each one assumes the previous ones.

| File | Purpose |
|---|---|
| `01-BRIEF.md` | The task, the constraints, the non-negotiables, the definition of done. **Start here.** |
| `02-UPSTREAM-FINDINGS.md` | Everything already learned about the upstream repo (commit `a725178`, 2026-10-30). Saves you re-discovering it. Trust it, but re-verify any line marked ⚠ against the live checkout. |
| `03-ARCHITECTURE.md` | The design: process model, directory layout, state machine, IPC contract, update flow, security model. |
| `04-IMPLEMENTATION-PLAN.md` | Phased plan with explicit tasks and acceptance criteria per phase. Work through it in order. |
| `05-PRODUCTION-READINESS.md` | Signing, notarization, CI, QA matrix, release process. The app is not "done" until this file is fully ticked. |
| `06-WEBSITE.md` | Brief for the marketing/download site at opentac.icu, including the mandatory attribution to the upstream author. |
| `07-AI-PROVIDERS.md` | What AI upstream uses, what can be routed to Ollama / OpenRouter / xAI, and how to do it without patching upstream. |
| `08-STAGED-UPDATES.md` | The gated update pipeline: upstream → mirror → tests → canary → `stable`. **Supersedes the direct-from-upstream parts of 03/04.** |
| `CLAUDE.md` | Drop this at the root of the new project. Conventions, commands and guardrails for Claude Code. |
| `scaffold/` | Starter files (package.json, electron-builder.yml, entitlements, launcher script, build scripts, module skeletons). Use them as the starting point, not as finished code. |

## How to use this pack with Claude Code

1. Create an empty directory for the new project (name: `opentac`).
2. Copy `scaffold/*` into it, and `CLAUDE.md` to its root.
3. Open Claude Code there and give it this instruction:

   > Read 01-BRIEF.md, 02-UPSTREAM-FINDINGS.md, 03-ARCHITECTURE.md,
   > 04-IMPLEMENTATION-PLAN.md, 07-AI-PROVIDERS.md and 08-STAGED-UPDATES.md in full before writing any code. Then execute
   > the implementation plan phase by phase. Do not skip a phase's acceptance
   > criteria. Stop and ask me only for the items listed under "Needs a human"
   > in 05-PRODUCTION-READINESS.md.

4. Keep the pack's markdown files inside the project under `docs/brief/` so
   they stay versioned with the code.

## Things the human owner must supply (Claude Code cannot)

- An Apple Developer ID (Application) certificate and an App Store Connect
  API key or app-specific password, for signing and notarization.
- Two GitHub repositories: `opentac` (the app) and `opentac-engine` (a fork of upstream used only as the tested mirror — see 08).
- A GitHub repository for the OpenTac app (for CI, downloads and shell auto-updates).
- The domain `opentac.icu` with DNS access, for the website (06-WEBSITE.md).
- A real Mac for the manual QA items that need a microphone and an RTL-SDR
  dongle.
