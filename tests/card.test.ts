import { describe, it, expect } from "vitest";
import { shareText, shareLinks, cardSvg, renderCardShare, type CardData } from "../src/card.js";

const d: CardData = {
  broken: 11, followed: 9, judgment: 14, sessions: 42, days: 30, who: "Claude",
  brokenTitles: ["Never push to `main`", "Never edit `.env`"],
};

describe("card share text", () => {
  it("carries counts only by default — never rule text or paths", () => {
    const t = shareText(d);
    expect(t).toContain("11 time");
    expect(t).toContain("rulereceipt.dev");
    expect(t).not.toContain("main");
    expect(t).not.toContain(".env");
  });
  it("--show-rules opts the rule names into the copy-text", () => {
    expect(shareText(d, true)).toContain("Never push to");
  });
  it("0 broken → a clean, honest caption (no negativity invented)", () => {
    expect(shareText({ ...d, broken: 0 })).toContain("0 broken");
  });
});

describe("single-session framing (browser drop of one session)", () => {
  const one: CardData = { broken: 2, followed: 5, judgment: 3, sessions: 1, days: 0, who: "the agent" };
  it("shareText says 'this session', not 'in 0 days (1 sessions)'", () => {
    const t = shareText(one);
    expect(t).toContain("this session");
    expect(t).not.toContain("0 days");
    expect(t).not.toContain("1 sessions");
  });
  it("cardSvg omits the 'last N days' clause when days is 0", () => {
    const svg = cardSvg(one);
    expect(svg).not.toContain("0 days");
    expect(svg).toContain("1 session");
  });
  it("still shows 'last N days' for a multi-day history card", () => {
    expect(cardSvg(d)).toContain("last 30 days");
  });
});

describe("card share links", () => {
  it("are well-formed compose links (no auth, user sends it)", () => {
    const l = shareLinks("hello world");
    expect(l.x).toContain("twitter.com/intent/tweet?text=hello%20world");
    expect(l.bluesky).toContain("bsky.app/intent/compose?text=");
    expect(l.linkedin).toContain("linkedin.com/sharing/share-offsite");
    expect(l.reddit).toContain("reddit.com/submit");
  });
});

describe("card svg", () => {
  it("shows counts, never rule text or paths", () => {
    const svg = cardSvg(d);
    expect(svg).toContain("<svg");
    expect(svg).toContain("11"); // the broken count
    expect(svg).toContain("42 sessions");
    expect(svg).not.toContain("main");
    expect(svg).not.toContain(".env");
  });
  it("escapes hostile text so a rule/tool name can't inject markup", () => {
    const svg = cardSvg({ ...d, who: "<script>x</script>" });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});

describe("renderCardShare", () => {
  it("prints no rule text by default and says the rule names were left out", () => {
    const out = renderCardShare(d, "/tmp/card.svg");
    expect(out).not.toContain("main");
    expect(out).not.toContain(".env");
    expect(out).toContain("counts only");
    expect(out).toContain("--show-rules");
  });
});
