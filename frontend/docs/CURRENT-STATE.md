# Current State

## First-run launcher

A surface class that never clears means no launcher for that page. This is
accepted and deliberately not timed out: a "reveal anyway after N seconds"
would trade a benign no-show for the card punching through a recording in
progress. See `src/firstRunExperience.js` (ACCEPTED, DELIBERATELY NOT TIMED
OUT).
