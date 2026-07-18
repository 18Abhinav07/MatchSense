---
created: 2026-07-19
project: matchsense
ecosystem: full-stack
tags: [implementation-plan, ui, onboarding, profile]
---

# Profile UI Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

[[Hackathons/MatchSense/BUILD/docs/superpowers/specs/2026-07-19-profile-ui-refinement-design]] | [[Hackathons/MatchSense/BUILD/docs/superpowers/plans/2026-07-18-real-data-end-to-end-implementation]]

**Goal:** Refine onboarding and profile controls without changing any server-backed identity behavior.

**Architecture:** Keep state local to `ProfileSurface`. Extract the confirmation markup into a small renderable dialog component, then apply responsive CSS within the existing fan surface stylesheet. Remove the Today masthead label at its source.

**Tech Stack:** React 19, TypeScript, CSS, Vitest.

---

### Task 1: Lock the approved UI contract

**Files:**

- Modify: `apps/web/src/features/fan/FanSurfaces.test.tsx`
- Modify: `apps/web/src/features/today/TodayHub.test.tsx`

- [ ] Add a failing render test requiring a modal dialog with `Delete everything` and `Cancel` actions.
- [ ] Add a failing Today test requiring the retired `World Cup match desk` label to be absent.
- [ ] Run the two focused test files and confirm the expected failures before production edits.

### Task 2: Implement the surface and responsive styling

**Files:**

- Modify: `apps/web/src/features/fan/FanSurfaces.tsx`
- Modify: `apps/web/src/features/fan/fan-surfaces.css`
- Modify: `apps/web/src/features/today/TodayHub.tsx`

- [ ] Render the destructive confirmation as a centered `role="dialog"` overlay.
- [ ] Keep Delete profile as the opener, Cancel as a pure state reset, and Delete everything as the only API mutation action.
- [ ] Remove the Today masthead label.
- [ ] Restyle the onboarding handle surface without a visible border.
- [ ] Make profile fields full-width with a minimum 54px height and 16px rounded corners.
- [ ] Style Delete profile as a full red action matching Save profile's dimensions.
- [ ] Run focused tests, the web suite, typecheck, build, formatting, and `git diff --check`.
- [ ] Commit and deploy the verified patch.
