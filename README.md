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
- PostgreSQL for future persistence

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

Product behavior is intentionally deferred beyond the scaffold.

Vault context: [[10-Projects/Web3-Builds/Hackathons/MatchSense/HANDOFF]] · [[10-Projects/Web3-Builds/Hackathons/MatchSense/AGENTS]]
