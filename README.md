---
created: 2026-07-16
project: matchsense
ecosystem: full-stack
tags: [matchsense, production, workspace]
---

# MatchSense Production Workspace

Lean pnpm monorepo for the MatchSense hackathon PWA, API service, and collector worker.

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

MatchSense runs as **one API replica** plus one separate **collector worker
service**. The API serves the PWA, database-backed reads, anonymous fan
sessions, and encrypted push-subscription registration. The collector alone
holds TxLINE credentials and owns migrations, ingestion, and outbox work.

[`railway.json`](railway.json) is the API service template: it selects the root
Dockerfile and uses database-backed `/health/ready` as Railway's health gate.
[`railway.worker.json`](railway.worker.json) is the worker-service template: it
starts with `ROLE=worker` and deliberately has no HTTP healthcheck. Keep both
Railway service roots at this repository root so the pnpm workspace and shared
packages remain in the Docker build context. The shared image defaults to
`ROLE=api`; set `ROLE=worker` only on the private worker service.

Provision a Railway PostgreSQL service and configure these application
variables:

| Variable                              | Requirement                                      | Purpose                                                                                                                         |
| ------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                        | Required on both services                        | Use the PostgreSQL service's private `DATABASE_URL` reference.                                                                  |
| `ROLE`                                | Required by deployment convention                | `api` for the public PWA/API service; `worker` for the private collector.                                                       |
| `TXLINE_API_TOKEN`                    | Required only on `ROLE=worker`                   | Server-only TxLINE schedule and SSE credential. Never assign it to the API service.                                             |
| `DATA_RIGHTS_MODE`                    | Optional                                         | Defaults to `txline_hackathon`; the public API rejects synthetic demo mode.                                                     |
| `VAPID_PUBLIC_KEY`                    | Required on the API when push registration is on | Public application-server key exposed to subscribed browsers.                                                                   |
| `PUSH_SUBSCRIPTION_ENCRYPTION_SECRET` | Required with Web Push on both services          | Encrypts stored browser subscriptions; it is separate from the VAPID signing private key.                                       |
| `VAPID_SUBJECT`                       | Required only on `ROLE=worker` for Web Push      | A `mailto:` or HTTPS contact for VAPID signing.                                                                                 |
| `VAPID_PRIVATE_KEY`                   | Required only on `ROLE=worker` for Web Push      | Server-only VAPID signing key. Never assign it to the API service or expose it to the PWA.                                      |
| `GROQ_API_KEY`                        | Optional                                         | Enhances canonical-event commentary text; deterministic text remains available without it.                                      |
| `GEMINI_API_KEY`                      | Optional                                         | Enables generated TTS. `GOOGLE_API_KEY` is accepted as its alias; the deterministic audio cue remains available without either. |

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
the API role with no TxLINE credential so container, migration, PWA routing,
health, and graceful-shutdown checks remain deterministic.

Vault context: [[10-Projects/Web3-Builds/Hackathons/MatchSense/HANDOFF]] · [[10-Projects/Web3-Builds/Hackathons/MatchSense/AGENTS]]
