---
created: 2026-07-19
project: matchsense
ecosystem: full-stack
tags: [audio, experience, gemini, tts, operator-guide]
---

# MatchSense Experience — Gemini AI Studio Audio Guide

[[10-Projects/Web3-Builds/Hackathons/MatchSense/HANDOFF]] |
[[10-Projects/Web3-Builds/Hackathons/MatchSense/BUILD/docs/superpowers/specs/2026-07-19-fixed-experience-audio-pack-design]]

## Locked generation settings

- Surface: Google AI Studio Voice Library / speech generation.
- Model: `Gemini 3.1 Flash TTS Preview`.
- Mode: single speaker.
- Voice: `Kore` for every clip.
- Output: WAV, one file per prompt.
- Character: one neutral international football commentator with a subtle British broadcast cadence.
- Never add music, crowd noise, reverb, another speaker, or words outside the transcript.
- Keep the voice identity constant. Emotion follows the event; it does not become partisan.

Google documents natural-language control of TTS style, accent, pace and tone, and lists Kore as an available voice: https://ai.google.dev/gemini-api/docs/speech-generation

## Operator procedure

1. Select `Gemini 3.1 Flash TTS Preview`, single-speaker mode and `Kore`.
2. Paste one complete prompt below.
3. Generate up to three candidates only when necessary; choose the one whose voice most closely matches the other accepted clips.
4. Reject any take that adds, removes or changes a spoken word; reads the directions aloud; changes commentator identity; clips a syllable; or contains an audio artifact.
5. Download WAV and rename it to the exact filename shown below.
6. Do not convert, normalize, trim aggressively, or add effects. Give the 21 WAV files to the build operator for deterministic MP3 transcoding and manifest regeneration.

## Audio profile used in every prompt

The commentator is a credible live international football broadcaster: emotionally responsive, clear and natural, never a screen reader, never an advertisement, and never a caricature. Use a subtle British football-broadcast cadence without exaggerating the accent. Preserve natural breaths and short dramatic pauses. Speak only the labelled transcript.

## 01 — Kickoff

Filename: `kickoff.wav`

```text
Synthesize a single-speaker football broadcast clip.

Audio profile: One credible live international football commentator with a subtle British broadcast cadence. Natural, warm and human; never a screen reader or announcer imitation.

Scene: The World Cup final has just kicked off. The stadium is alive and the commentator is welcoming listeners into the match.

Director's notes: Confident anticipation, energy 6 out of 10. Begin cleanly and authoritatively, add warmth when describing the colours, and finish "starts now" with forward momentum. Medium pace. Do not shout. Do not add crowd noise, sound effects, music or any words. Speak only the transcript.

SPOKEN TRANSCRIPT:
The final is under way. Argentina in sky blue and white, France in deep blue. Five minutes of MatchSense starts now.
```

## 02 — Opening goal, still provisional

Filename: `opening-goal.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator, with a subtle British broadcast cadence and natural emotional control.

Scene: Argentina have just put the ball in the net, but the outcome is not confirmed. Excitement arrives instantly and is deliberately pulled back.

Director's notes: Start with a sharp burst of surprise on "Argentina have the ball in the net", then immediately become controlled and cautionary. Energy falls from 8 to 4 out of 10. Put a meaningful pause before "The goal is still provisional." Do not celebrate fully. Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
Argentina have the ball in the net, but hold the celebration. The goal is still provisional.
```

## 03 — Opening goal VAR review

Filename: `opening-goal-var-review.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: Play has paused while VAR checks Argentina's apparent goal. The stadium is waiting.

Director's notes: Tense, restrained and slightly quieter, energy 4 out of 10. Slow down around "VAR is checking" and make the uncertainty feel real without whispering. End firmly on "not been confirmed." Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
VAR is checking Argentina's goal. The score has not been confirmed.
```

## 04 — Opening goal stands

Filename: `opening-goal-var-stands.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: The VAR check ends and Argentina's goal is confirmed. Held tension releases into celebration.

Director's notes: Begin controlled on "The check is complete." Build rapidly through "The goal stands" and deliver the final score with joyful authority, energy 9 out of 10. Stress "stands" and "Argentina lead". A short natural celebratory lift is welcome, but do not add words or non-verbal sounds. No music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
The check is complete. The goal stands. Argentina lead France one nil.
```

## 05 — Argentina yellow card

Filename: `home-yellow.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: Argentina receive the first yellow card of the match.

Director's notes: Crisp, factual and alert, energy 4 out of 10. Give "Yellow card" a firm opening emphasis, then deliver the team and minute naturally. This is an important update, not a celebration. Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
Yellow card for Argentina in the twenty-fourth minute.
```

## 06 — France yellow card

Filename: `away-yellow-first-half.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: France receive a yellow card, bringing both teams level on cards.

Director's notes: Firm and observant, energy 5 out of 10. Emphasize "France now see yellow", then slightly broaden the delivery of the consequence: one card for each side. Do not sound pleased or disappointed. Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
France now see yellow. One card for each side in this final.
```

## 07 — Penalty awarded to France

Filename: `away-penalty-awarded.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: A penalty has suddenly been awarded to France shortly before half-time.

Director's notes: Immediate urgency and shock on "Penalty to France", energy 8 out of 10. Pause briefly, then lower into tense anticipation for the chance to equalise. Stress "huge chance" and "before half-time". Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
Penalty to France. A huge chance to level the match before half-time.
```

## 08 — France score the penalty

Filename: `away-penalty-scored.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: France convert the penalty and level the final.

Director's notes: A decisive emotional release, energy 8 out of 10. Hit "France score" strongly, then deliver the level score clearly and with significance. Excited but not as explosive as an open-play winning goal. Do not add words, cheers, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
France score from the penalty spot. Argentina one, France one.
```

## 09 — Half-time

Filename: `half-time.wav`

```text
Synthesize a single-speaker football broadcast clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: The first half ends level after an eventful forty-five minutes.

Director's notes: Let the energy settle to 4 out of 10. Reflective, composed and cinematic. State the score clearly, then give "Everything is still open" quiet anticipation rather than hype. Medium-slow pace. Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
Half-time in the final. Argentina one, France one. Everything is still open.
```

## 10 — Second half begins

Filename: `second-half.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: The teams return and the second half starts with the final still level.

Director's notes: Renewed momentum, energy 6 out of 10. Sound refreshed and forward-looking. Keep the timing explanation clean and natural, with a slight smile in the voice on "two and a half minutes in this Experience." Do not make it sound promotional. Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
The second half begins. Forty-five minutes in the match, two and a half minutes in this Experience.
```

## 11 — France red card

Filename: `away-red.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: France receive a red card with the final level. The entire match has changed.

Director's notes: Sudden shock and gravity, energy 8 out of 10. Strike "Red card for France" hard, pause, then explain the consequence in a lower, serious tone. This is dramatic but not celebratory. Stress "down to ten" and "match level". Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
Red card for France. They are down to ten with the match level at one each.
```

## 12 — Another Argentina yellow

Filename: `home-yellow-second-half.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: Argentina receive another yellow as the match becomes increasingly tense.

Director's notes: Urgent but concise, energy 5 out of 10. Emphasize "Another yellow card" and let "pressure rises" carry a slight sense of danger. Do not over-dramatize a routine card. Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
Another yellow card for Argentina as the pressure rises.
```

## 13 — Another France yellow

Filename: `away-yellow-second-half.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: France also receive another yellow almost immediately. The match is becoming chaotic.

Director's notes: Alert and slightly breathless, energy 6 out of 10. Deliver the first sentence firmly, then make "Two cards arrive almost together" sound like a notable escalation. Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
France receive another yellow. Two cards arrive almost together.
```

## 14 — Argentina's late winning goal

Filename: `winning-goal.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: Argentina score late in the World Cup final and take a two-one lead.

Director's notes: This is the emotional peak, energy 10 out of 10. Give "Goal for Argentina!" a powerful, authentic live-broadcast burst with a slightly sustained "Goal", then remain excited but intelligible through the consequence. Stress "late" and "lead France two goals to one." Do not add names, words, cheers, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
Goal for Argentina! They strike late and lead France two goals to one.
```

## 15 — France apparent equaliser, provisional

Filename: `apparent-equalizer.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: France appear to equalise late, but the result is not confirmed.

Director's notes: Begin with an instinctive surge of excitement, energy 8 out of 10, then visibly pull the emotion back at "but". Deliver "the equaliser is provisional" with caution and finish "Celebration is held" in disciplined suspense. Do not celebrate the goal as confirmed. Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
France have the ball in the net, but the equaliser is provisional. Celebration is held.
```

## 16 — VAR reviews the apparent equaliser

Filename: `equalizer-var-review.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: VAR is examining France's apparent late equaliser while Argentina still officially lead two-one.

Director's notes: Hushed tension without whispering, energy 4 out of 10. Slow the pace and place weight on "reviewing" and "holding the score". Make the listener feel the stadium waiting. Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
VAR is reviewing France's apparent equaliser. MatchSense is holding the score at two one.
```

## 17 — Equaliser overturned

Filename: `equalizer-var-overturned.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: VAR overturns France's apparent equaliser. Argentina's two-one lead survives.

Director's notes: Deliver "No goal" as an immediate, decisive ruling, then release the tension with authoritative clarity, energy 8 out of 10. Stress "overturns" and "Argentina still lead" without sounding partisan or triumphant at France's expense. Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
No goal. VAR overturns the equaliser. Argentina still lead France two one.
```

## 18 — Late Argentina corner

Filename: `late-corner.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: Argentina win a corner in stoppage time while protecting a one-goal lead.

Director's notes: Late-match urgency and tactical awareness, energy 7 out of 10. Hit "Late corner for Argentina" promptly, then slow slightly to explain how valuable the seconds are. Keep tension alive. Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
Late corner for Argentina. They can take precious seconds out of the match.
```

## 19 — Final whistle approaching

Filename: `regulation-end.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: The final whistle is seconds away and Argentina are protecting a two-one lead.

Director's notes: Controlled breathless anticipation, energy 7 out of 10. Make "moments away" feel immediate and place firm weight on the scoreline. Do not sound as if full-time has already happened. Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
The final whistle is moments away. Argentina remain two one ahead.
```

## 20 — Full-time

Filename: `full-time.wav`

```text
Synthesize a single-speaker live football commentary clip.

Audio profile: The same credible international football commentator with a subtle British broadcast cadence.

Scene: The final whistle has gone. Argentina have won the final two-one after a dramatic match.

Director's notes: Begin with a definitive full-time declaration, then open into a warm, cinematic conclusion, energy 8 out of 10. Sound moved by the occasion but remain a neutral professional. Clearly land the winner, score and dramatic context. Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
Full-time. Argentina beat France two goals to one after two VAR reviews and a dramatic finish.
```

## 21 — Match Memory introduction

Filename: `memory-intro.wav`

```text
Synthesize a single-speaker sports-storytelling clip.

Audio profile: The same recognizable international football commentator used for the live match, now speaking in a warmer and more reflective studio tone with a subtle British broadcast cadence.

Scene: The live match has ended and MatchSense is about to replay its decisive moments as a personal Match Memory.

Director's notes: Warm, polished and inviting, energy 4 out of 10. This is not live commentary and not an advertisement. Use a gentle sense of anticipation on "Relive the decisive calls". Medium-slow pace. Do not add or change words, music, crowd noise or effects. Speak only the transcript.

SPOKEN TRANSCRIPT:
Here is your MatchSense match summary. Relive the decisive calls from Argentina against France.
```

## Acceptance checklist

Each delivered WAV must pass all checks:

- Correct Kore voice and consistent commentator identity.
- Exact transcript; no inserted, omitted or paraphrased words.
- Event-appropriate emotion without partisanship.
- No spoken prompt instructions.
- No music, crowd bed, sound effects, second speaker or excessive reverb.
- Clean opening and complete final syllable.
- Winning goal is the emotional peak; VAR holds are deliberately restrained.
- Match Memory intro sounds warmer than live updates but remains the same commentator.

