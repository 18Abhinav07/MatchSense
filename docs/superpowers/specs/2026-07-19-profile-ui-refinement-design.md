---
created: 2026-07-19
project: matchsense
ecosystem: full-stack
tags: [ui, onboarding, profile, responsive]
---

# Profile UI Refinement

[[Hackathons/MatchSense/HANDOFF]] | [[Hackathons/MatchSense/BUILD/docs/superpowers/specs/2026-07-17-unified-match-experience-design]]

## Approved scope

- Keep onboarding, profile persistence, and deletion behavior unchanged.
- Remove the visible boundary treatment around the onboarding handle field while retaining a clear filled input surface and focus state.
- Apply that treatment to the active `OnboardingFlow` surface; it must not retain the green underline or browser focus outline.
- Replace repeated onboarding identity copy with a compact step indicator and short stage label.
- Remove the `World Cup match desk` masthead label.
- Make profile text inputs and selects full-width, comfortably tall, and softly rounded on phone and desktop.
- Reset native select appearance so iOS renders the same full-width rounded control instead of a narrow system rectangle.
- Present profile deletion as a red destructive button matching the save control's weight.
- Replace the inline second-tap confirmation with an accessible centered confirmation dialog containing Cancel and Delete everything actions.

## Interaction contract

The first Delete profile click opens the dialog and performs no mutation. Cancel closes it. Delete everything invokes the existing `deleteProfile()` API once, retains the existing deleting/error states, and returns to onboarding through the existing `onDeleted()` callback after success.
