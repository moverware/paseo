import { describe, expect, test } from "vitest";
import { extractRoutedHookNote } from "./agent.js";

describe("extractRoutedHookNote", () => {
  const wrap = (stderr: string, original?: string) =>
    `UserPromptSubmit operation blocked by hook:\n[/Users/mover/hooks/route.py]: ${stderr}${
      original ? `\n\n\nOriginal prompt: ${original}` : ""
    }`;

  test("returns the bare stderr line for a routed block", () => {
    expect(extractRoutedHookNote(wrap("⤳ desk · repos — reply streams here", "merge it"))).toBe(
      "⤳ desk · repos — reply streams here",
    );
  });

  test("returns the bare marker for a silent routing", () => {
    expect(extractRoutedHookNote(wrap("⤳", "5 - hardware"))).toBe("⤳");
  });

  test("leaves unmarked hook blocks alone", () => {
    expect(extractRoutedHookNote(wrap("Session continued in another client"))).toBeNull();
  });

  test("ignores non-hook result text", () => {
    expect(extractRoutedHookNote("Unknown command: /voice")).toBeNull();
  });
});

describe("extractRoutedHookNote with multiple blocking hooks", () => {
  test("finds the marker when another hook's block precedes it", () => {
    const text =
      "UserPromptSubmit operation blocked by hook:\n" +
      "[/hooks/session-watermark.py check]: Session continued in another client (last write there at 02:29).\n" +
      "This window's context is stale; submitting would fork the conversation.\n" +
      "[/hooks/route-phone-message.py]: ⤳\n\n\nOriginal prompt: hi";
    expect(extractRoutedHookNote(text)).toBe("⤳");
  });

  test("still null when no marker in any hook line", () => {
    const text =
      "UserPromptSubmit operation blocked by hook:\n" +
      "[/hooks/session-watermark.py check]: Session continued in another client.";
    expect(extractRoutedHookNote(text)).toBeNull();
  });
});
