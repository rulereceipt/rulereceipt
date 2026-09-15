import { describe, it, expect } from "vitest";
import { classifyRule } from "../src/checks/classify.js";

/**
 * A backtick literal is only CODE if something calls something.
 *
 * The test was "contains an open parenthesis", which is true of a great deal
 * of ordinary prose. Measured 2026-09-15 across 559 public rules files: 74 of
 * 1,086 literals routed to content matching (6.8%) were not code - "(e.g.",
 * "(soft)", a markdown link fragment, and three entire blocks of accounting
 * formulae. One of them, "(in the", produced a real false accusation: the
 * report said it had been "actually written into a file", which is true of
 * any file containing that phrase.
 *
 * Same family as the some() fault fixed on 2026-09-13 and the branch-name
 * fault fixed on 2026-09-14: a local syntactic cue promoting a whole text
 * into the wrong checker. The cue now has to look like a call - an
 * identifier, optionally dotted or scoped, immediately before the paren.
 *
 * Literals below are verbatim from the corpus.
 */
const kindOf = (literal: string, verb = "Never use") =>
  classifyRule({ id: "1", title: "Code style", text: `${verb} \`${literal}\` anywhere.`, source: "project" }).kind;

describe("content matching requires a literal that looks like a call", () => {
  for (const good of ["console.log(", "new Date()", "run()", "analytics.track(", "std::cout("]) {
    it(`still routes ${good}`, () => expect(kindOf(good)).toBe("codeContent"));
  }

  for (const bad of ["(in the", "(e.g.", "(soft)", "(new, durable).", "(project root)/.aider.conf.yml"]) {
    it(`does not route ${JSON.stringify(bad)}`, () => expect(kindOf(bad)).not.toBe("codeContent"));
  }
});
