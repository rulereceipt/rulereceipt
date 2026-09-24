import { describe, it, expect } from "vitest";
import { analyze as sourceAnalyze } from "../src/browser/analyze.js";
// The COMMITTED, minified bundle the website actually serves.
import { analyze as bundledAnalyze } from "../landing/checker.js";

/**
 * The site says "same classifier the CLI uses, compiled to run in the page —
 * so this and the tool agree by construction." That is only true while the
 * committed bundle is rebuilt from source. It is a standalone `build:checker`
 * script nothing calls, so it silently drifted for weeks (missing emoji,
 * attribution, approval-gate and the isNotARule fixes) until 2026-09-24.
 *
 * This test makes the claim self-enforcing: run a rule set that exercises the
 * routes that most recently changed through BOTH classifiers and require the
 * same result. If someone edits the classifier and forgets `npm run
 * build:checker`, this fails and names the fix.
 */
const SAMPLE = `# Rules
## 1. Never use emojis in replies
## 2. No AI trace in git commits
Never add \`Co-Authored-By: Claude\` to a commit.
## 3. Ask first before you push
## 4. Never push to the \`main\` branch
## 5. Surface bad news first; keep replies concise
## 6. Before you delete data, wait for confirmation
## 7. Deployment history
Notes on how the pipeline was set up last quarter.
`;

describe("landing/checker.js is rebuilt from the source classifier", () => {
  it("the committed bundle agrees with src/browser/analyze on every kind", () => {
    const fromBundle = bundledAnalyze(SAMPLE);
    const fromSource = sourceAnalyze(SAMPLE);
    // If this fails, the bundle is stale: run `npm run build:checker`.
    expect(fromBundle).toEqual(fromSource);
  });
});
