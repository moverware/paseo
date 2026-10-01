import { describe, expect, test } from "vitest";

import { extractUserMessageText } from "./agent.js";

describe("extractUserMessageText", () => {
  test("returns trimmed string content", () => {
    expect(extractUserMessageText("  Hello world  ")).toBe("Hello world");
  });

  test("combines multiple text blocks", () => {
    const content = [
      { type: "text", text: "First line" },
      { type: "text", text: "Second line" },
    ];

    expect(extractUserMessageText(content)).toBe("First line\n\nSecond line");
  });

  test("shows a pasted prompt without Claude Code's pasted_content framing", () => {
    const content =
      'see below\n\n<pasted_content id="9942">\nfirst paragraph\n\nsecond\n</pasted_content id="9942">';

    expect(extractUserMessageText(content)).toBe("see below\n\nfirst paragraph\n\nsecond");
  });

  test("leaves pasted_content text alone when the closing id does not match", () => {
    const content = '<pasted_content id="9942">\nbody\n</pasted_content id="abcd">';

    expect(extractUserMessageText(content)).toBe(content);
  });

  test("returns Claude slash command prompts without transcript tags", () => {
    const content =
      "<command-message>diagnose</command-message>\n<command-name>/diagnose</command-name>\n<command-args>recently the PR data does not update</command-args>";

    expect(extractUserMessageText(content)).toBe("/diagnose recently the PR data does not update");
  });

  test("returns the Claude slash command prompt when no args were recorded", () => {
    const content =
      "<command-message>caveman:caveman</command-message>\n<command-name>/caveman:caveman</command-name>";

    expect(extractUserMessageText(content)).toBe("/caveman:caveman");
  });

  test("returns null when no textual content is present", () => {
    const content = [
      { type: "image", source: "foo.png" },
      { type: "file", path: "bar.txt" },
    ];

    expect(extractUserMessageText(content)).toBeNull();
  });
});
