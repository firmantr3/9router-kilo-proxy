import { describe, it, expect, afterAll } from "bun:test";
import {
  applyStripRules,
  applyInjectRules,
  loadStripRules,
  loadInjectRule,
  processBody,
  type ChatMessage,
  type StripRule,
  type InjectRule,
  type InjectConfig,
} from "./index.ts";

function sys(s: string): ChatMessage {
  return { role: "system", content: s };
}
function user(s: string): ChatMessage {
  return { role: "user", content: s };
}

describe("applyStripRules", () => {
  it("strips content between startsWith and endsWith in a system message", () => {
    const msgs: ChatMessage[] = [sys("HEAD You are Kilo, secret END TAIL")];
    const rules: StripRule[] = [{ startsWith: "You are Kilo,", endsWith: "END" }];
    const mod = applyStripRules(msgs, rules);
    expect(mod).toBe(true);
    expect(msgs[0].content).toBe("HEAD  TAIL");
  });

  it("strips across multiple system messages", () => {
    const msgs: ChatMessage[] = [
      sys("A You are Kilo, x END B"),
      sys("C You are Kilo, y END D"),
    ];
    const rules: StripRule[] = [{ startsWith: "You are Kilo,", endsWith: "END" }];
    applyStripRules(msgs, rules);
    expect(msgs[0].content).toBe("A  B");
    expect(msgs[1].content).toBe("C  D");
  });

  it("leaves content unchanged when no rule matches", () => {
    const msgs: ChatMessage[] = [sys("nothing here")];
    const rules: StripRule[] = [{ startsWith: "You are Kilo,", endsWith: "END" }];
    const mod = applyStripRules(msgs, rules);
    expect(mod).toBe(false);
    expect(msgs[0].content).toBe("nothing here");
  });

  it("skips when endsWith appears before startsWith", () => {
    const msgs: ChatMessage[] = [sys("END foo You are Kilo, bar")];
    const rules: StripRule[] = [{ startsWith: "You are Kilo,", endsWith: "END" }];
    const mod = applyStripRules(msgs, rules);
    expect(mod).toBe(false);
    expect(msgs[0].content).toBe("END foo You are Kilo, bar");
  });

  it("skips non-string system content (e.g. array content)", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: [{ type: "text", text: "You are Kilo, x END" }] },
    ];
    const rules: StripRule[] = [{ startsWith: "You are Kilo,", endsWith: "END" }];
    const mod = applyStripRules(msgs, rules);
    expect(mod).toBe(false);
  });

  it("does not touch non-system messages", () => {
    const msgs: ChatMessage[] = [
      user("You are Kilo, secret END"),
    ];
    const rules: StripRule[] = [{ startsWith: "You are Kilo,", endsWith: "END" }];
    const mod = applyStripRules(msgs, rules);
    expect(mod).toBe(false);
    expect(msgs[0].content).toBe("You are Kilo, secret END");
  });

  it("applies multiple rules cumulatively", () => {
    const msgs: ChatMessage[] = [sys("A START1 x END1 B START2 y END2 C")];
    const rules: StripRule[] = [
      { startsWith: "START1", endsWith: "END1" },
      { startsWith: "START2", endsWith: "END2" },
    ];
    applyStripRules(msgs, rules);
    expect(msgs[0].content).toBe("A  B  C");
  });

  it("ignores degenerate rules with empty markers", () => {
    const msgs: ChatMessage[] = [sys("You are Kilo, x END")];
    const rules: StripRule[] = [{ startsWith: "", endsWith: "" }];
    const mod = applyStripRules(msgs, rules);
    expect(mod).toBe(false);
    expect(msgs[0].content).toBe("You are Kilo, x END");
  });
});

describe("applyInjectRules", () => {
  it("wraps the first user message (string content)", () => {
    const msgs: ChatMessage[] = [sys("S"), user("hello")];
    const rule: InjectRule = { start: "<<", end: ">>" };
    const mod = applyInjectRules(msgs, rule);
    expect(mod).toBe(true);
    expect(msgs[1].content).toBe("<<hello>>");
    expect(msgs[0].content).toBe("S"); // system untouched when no system rules
  });

  it("wraps the first user message (array content with text part)", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: [{ type: "image" }, { type: "text", text: "hi" }] },
    ];
    const rule: InjectRule = { start: "P:", end: ":Q" };
    applyInjectRules(msgs, rule);
    const content = msgs[0].content as Array<{ type: string; text?: string }>;
    expect(content[1].text).toBe("P:hi:Q");
  });

  it("only wraps the FIRST user message", () => {
    const msgs: ChatMessage[] = [user("one"), user("two")];
    const rule: InjectRule = { start: "X", end: "Y" };
    applyInjectRules(msgs, rule);
    expect(msgs[0].content).toBe("XoneY");
    expect(msgs[1].content).toBe("two");
  });

  it("injects into system messages", () => {
    const msgs: ChatMessage[] = [sys("S")];
    const rule: InjectRule = { start_system: "[sys]", end_system: "[/sys]" };
    applyInjectRules(msgs, rule);
    expect(msgs[0].content).toBe("[sys]S[/sys]");
  });

  it("does not modify anything when all markers empty", () => {
    const msgs: ChatMessage[] = [sys("S"), user("u")];
    const rule: InjectRule = {};
    const mod = applyInjectRules(msgs, rule);
    expect(mod).toBe(false);
    expect(msgs[0].content).toBe("S");
    expect(msgs[1].content).toBe("u");
  });

  it("skips user message with non-string, non-array content", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: 42 }];
    const rule: InjectRule = { start: "X", end: "Y" };
    const mod = applyInjectRules(msgs, rule);
    expect(mod).toBe(false);
  });

  it("skips array content with no text part", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: [{ type: "image" }] }];
    const rule: InjectRule = { start: "X", end: "Y" };
    const mod = applyInjectRules(msgs, rule);
    expect(mod).toBe(false);
  });

  it("applies strip then inject on the same system message", () => {
    const msgs: ChatMessage[] = [sys("PRE You are Kilo, secret END POST")];
    const stripRules: StripRule[] = [{ startsWith: "You are Kilo,", endsWith: "END" }];
    const injectRule: InjectRule = { start_system: "SYS[", end_system: "]SYS" };
    applyStripRules(msgs, stripRules);
    applyInjectRules(msgs, injectRule);
    expect(msgs[0].content).toBe("SYS[PRE  POST]SYS");
  });

  it("injects when only_when_string_exists is present in pre-strip snapshot", () => {
    const msgs: ChatMessage[] = [sys("S"), user("hello")];
    const rule: InjectRule = { start: "<<", end: ">>", only_when_string_exists: "hello" };
    const mod = applyInjectRules(msgs, rule, JSON.stringify({ messages: msgs }));
    expect(mod).toBe(true);
    expect(msgs[1].content).toBe("<<hello>>");
  });

  it("skips inject when only_when_string_exists absent from pre-strip snapshot", () => {
    const msgs: ChatMessage[] = [sys("S"), user("hello")];
    const rule: InjectRule = { start: "<<", end: ">>", only_when_string_exists: "You are Kilo" };
    const mod = applyInjectRules(msgs, rule, JSON.stringify({ messages: msgs }));
    expect(mod).toBe(false);
    expect(msgs[1].content).toBe("hello");
  });

  it("gates on pre-strip content even after strip removed the string", () => {
    const msgs: ChatMessage[] = [sys("PRE You are Kilo, secret END POST"), user("hi")];
    const stripRules: StripRule[] = [{ startsWith: "You are Kilo,", endsWith: "END" }];
    const injectRule: InjectRule = {
      start: "<<",
      end: ">>",
      only_when_string_exists: "You are Kilo",
    };
    const snapshot = JSON.stringify({ messages: msgs });
    applyStripRules(msgs, stripRules); // removes "You are Kilo" from system msg
    const mod = applyInjectRules(msgs, injectRule, snapshot);
    expect(mod).toBe(true); // gate saw it pre-strip
    expect(msgs[1].content).toBe("<<hi>>");
  });

  it("inject still runs when gate absent and markers set", () => {
    const msgs: ChatMessage[] = [user("hi")];
    const rule: InjectRule = { start: "<<", end: ">>" };
    const mod = applyInjectRules(msgs, rule, "irrelevant");
    expect(mod).toBe(true);
    expect(msgs[0].content).toBe("<<hi>>");
  });

  it("applies an array of inject rules in order", () => {
    const msgs: ChatMessage[] = [sys("S"), user("hi")];
    const config: InjectRule[] = [
      { start_system: "[", end_system: "]" },
      { start: "<<", end: ">>" },
    ];
    const mod = applyInjectRules(msgs, config, "hi");
    expect(mod).toBe(true);
    expect(msgs[0].content).toBe("[S]");
    expect(msgs[1].content).toBe("<<hi>>");
  });

  it("array rules gate independently via only_when_string_exists", () => {
    const msgs: ChatMessage[] = [sys("S"), user("hi")];
    const config: InjectRule[] = [
      { start: "YES[", end: "]YES", only_when_string_exists: "hi" },
      { start: "NO[", end: "]NO", only_when_string_exists: "absent-string" },
    ];
    const mod = applyInjectRules(msgs, config, "hi");
    expect(mod).toBe(true);
    expect(msgs[1].content).toBe("YES[hi]YES");
  });

  it("returns false when all array rules gated out", () => {
    const msgs: ChatMessage[] = [user("hi")];
    const config: InjectRule[] = [
      { start: "X", end: "Y", only_when_string_exists: "absent" },
    ];
    const mod = applyInjectRules(msgs, config, "hi");
    expect(mod).toBe(false);
    expect(msgs[0].content).toBe("hi");
  });

  it("empty array injects nothing", () => {
    const msgs: ChatMessage[] = [user("hi")];
    const mod = applyInjectRules(msgs, [], "hi");
    expect(mod).toBe(false);
    expect(msgs[0].content).toBe("hi");
  });
});

describe("loaders", () => {
  it("returns [] when strip.json is missing", async () => {
    expect(await loadStripRules("/nonexistent-dir-xyz")).toEqual([]);
  });
  it("returns null when inject.json is missing", async () => {
    expect(await loadInjectRule("/nonexistent-dir-xyz")).toBeNull();
  });
});

describe("processBody", () => {
  it("returns null for non-JSON body", async () => {
    expect(await processBody("not json at all")).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    expect(await processBody("{not valid json")).toBeNull();
  });

  it("returns null for JSON without a messages array", async () => {
    expect(await processBody('{"model":"gpt"}')).toBeNull();
  });

  it("returns null when rules exist but nothing matches", async () => {
    const dir = await writeTempRules([{ startsWith: "NOPE,", endsWith: "X" }], {});
    const out = await processBody('{"messages":[{"role":"user","content":"hi"}]}', dir);
    expect(out).toBeNull();
  });

  it("applies strip + inject end to end via rules on disk", async () => {
    const dir = await writeTempRules(
      [{ startsWith: "You are Kilo,", endsWith: "END" }],
      { start: "<<", end: ">>" },
    );
    const body = JSON.stringify({
      messages: [
        { role: "system", content: "H You are Kilo, X END T" },
        { role: "user", content: "hello" },
      ],
    });
    const out = await processBody(body, dir);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.messages[0].content).toBe("H  T");
    expect(parsed.messages[1].content).toBe("<<hello>>");
  });

  it("returns null (no modification) when body already has no match but inject empty", async () => {
    const dir = await writeTempRules([{ startsWith: "NOPE,", endsWith: "X" }], {});
    const out = await processBody('{"messages":[{"role":"user","content":"hi"}]}', dir);
    expect(out).toBeNull();
  });

  it("inject gated by only_when_string_exists via disk rules (present)", async () => {
    const dir = await writeTempRules(
      [{ startsWith: "You are Kilo,", endsWith: "END" }],
      { start: "<<", end: ">>", only_when_string_exists: "You are Kilo" },
    );
    const body = JSON.stringify({
      messages: [
        { role: "system", content: "H You are Kilo, X END T" },
        { role: "user", content: "hello" },
      ],
    });
    const out = await processBody(body, dir);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.messages[0].content).toBe("H  T");
    expect(parsed.messages[1].content).toBe("<<hello>>");
  });

  it("inject skipped by only_when_string_exists via disk rules (absent)", async () => {
    const dir = await writeTempRules(
      [{ startsWith: "NOPE,", endsWith: "X" }],
      { start: "<<", end: ">>", only_when_string_exists: "You are Kilo" },
    );
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
    });
    const out = await processBody(body, dir);
    expect(out).toBeNull();
  });

  it("array form via disk rules: applies matched rule only", async () => {
    const dir = await writeTempRules(
      [{ startsWith: "NOPE,", endsWith: "X" }],
      [
        { start: "YES[", end: "]YES", only_when_string_exists: "hello" },
        { start: "NO[", end: "]NO", only_when_string_exists: "nope" },
      ],
    );
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
    });
    const out = await processBody(body, dir);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.messages[0].content).toBe("YES[hello]YES");
  });
});

// Helpers for integration tests against real files on disk.
const tempDirs: string[] = [];
async function writeTempRules(strip: StripRule[], inject: InjectConfig): Promise<string> {
  const dir = `/tmp/9router-proxy-test-${tempDirs.length}-${Date.now()}`;
  tempDirs.push(dir);
  await Bun.write(joinPath(dir, "strip.json"), JSON.stringify(strip));
  await Bun.write(joinPath(dir, "inject.json"), JSON.stringify(inject));
  return dir;
}
function joinPath(dir: string, file: string): string {
  return dir + "/" + file;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await Bun.write(joinPath(dir, "strip.json"), "");
    // best-effort cleanup; ignore errors
  }
});
