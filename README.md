---
created: 2026-07-16
project: matchsense
ecosystem: full-stack
tags: [matchsense, production, workspace]
---

# MatchSense Production Workspace

Lean pnpm monorepo for the MatchSense hackathon PWA and its single Node server.

## Requirements

- Node.js 24 or newer
- pnpm 11.13.0
- PostgreSQL 17-compatible persistence

## Commands

```sh
npx --yes pnpm@11.13.0 install
npx --yes pnpm@11.13.0 test
npx --yes pnpm@11.13.0 typecheck
npx --yes pnpm@11.13.0 build
npx --yes pnpm@11.13.0 format:check
```

## Workspaces

- `apps/web`: progressive web application shell
- `apps/server`: single production server shell
- `packages/contracts`: shared boundary types
- `packages/db`: PostgreSQL persistence boundary
- `packages/txline-adapter`: transaction-line data boundary
- `packages/event-engine`: normalized event boundary
- `packages/moment-engine`: match-moment boundary
- `packages/commentary`: commentary boundary
- `packages/replay`: replay boundary
- `packages/ui`: shared presentation boundary

## Railway deployment contract

MatchSense must run as **exactly one Railway application replica**. Canonical
facts and fan records are durable in PostgreSQL, but SSE subscribers, active
Listening Mode streams, audio fanout, and listening-session ownership are
process-local. More than one application replica can route a follow-up request
to a process that does not own that listener.

[`railway.json`](railway.json) is the deployment source of truth. It selects the
root Dockerfile, disables sleeping and multi-region scaling, fixes the replica
count at one, disables deployment overlap, and uses database-backed
`/health/ready` as Railway's health gate. Keep the Railway service root at this
repository root so the pnpm workspace and shared packages remain in the Docker
build context. Do not override the start command or scale the app in the
dashboard.

Provision a Railway PostgreSQL service and configure these application
variables:

| Variable            | Requirement                                     | Purpose                                                                                                                         |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | Required                                        | Use the PostgreSQL service's private `DATABASE_URL` reference.                                                                  |
| `TXLINE_API_TOKEN`  | Required in the default `txline_hackathon` mode | Server-only TxLINE schedule and SSE credential.                                                                                 |
| `DATA_RIGHTS_MODE`  | Optional                                        | Defaults to `txline_hackathon`; `synthetic_demo` is only for explicit demo/test runs.                                           |
| `VAPID_SUBJECT`     | Required for Web Push                           | A `mailto:` or HTTPS contact. Set together with both VAPID keys.                                                                |
| `VAPID_PUBLIC_KEY`  | Required for Web Push                           | Public application-server key exposed to subscribed browsers.                                                                   |
| `VAPID_PRIVATE_KEY` | Required for Web Push                           | Server-only signing key. Never expose it to the PWA.                                                                            |
| `GROQ_API_KEY`      | Optional                                        | Enhances canonical-event commentary text; deterministic text remains available without it.                                      |
| `GEMINI_API_KEY`    | Optional                                        | Enables generated TTS. `GOOGLE_API_KEY` is accepted as its alias; the deterministic audio cue remains available without either. |

Railway injects `PORT`; the image binds it on `0.0.0.0`. Do not create a
separate frontend service: the Node server serves the built PWA and `/api`
routes from one origin, which is required for cookies, push activation, SSE,
and installable-PWA routing.

Health contracts:

- `/health/live` proves the Node process can answer HTTP.
- `/health/ready` proves PostgreSQL is reachable and migrations are current.
- TxLINE source health is reported by the product APIs and is not silently
  represented as database readiness.

Before release, run `pnpm test:container`. The smoke test deliberately starts
the same production image in `synthetic_demo` mode so container, migration,
PWA routing, health, and graceful-shutdown checks do not depend on an external
TxLINE credential.

Vault context: [[10-Projects/Web3-Builds/Hackathons/MatchSense/HANDOFF]] · [[10-Projects/Web3-Builds/Hackathons/MatchSense/AGENTS]]
