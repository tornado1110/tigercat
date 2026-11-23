import { describe, expect, it } from "vitest";
import { compileFilterRules } from "../../src/filter.js";

describe("filter rule compilation", () => {
  it("rejects invalid regular expressions with the rule name", () => {
    expect(() => compileFilterRules([{ name: "broken-rule", outcome: "ignore", match: { text: "(" } }]))
      .toThrow(/rule "broken-rule": invalid regular expression/);
  });

  it.each(["．", "＊", "＋", "？", "（", "）", "［", "］", "｛", "｝", "｜", "／", "＼"])(
    "keeps fullwidth metacharacter %s literal",
    (character) => {
      expect(() => compileFilterRules([{ name: "fullwidth", outcome: "ignore", match: { text: character } }])).not.toThrow();
    },
  );
});
