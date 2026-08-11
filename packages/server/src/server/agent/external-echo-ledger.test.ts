import { describe, expect, test } from "vitest";

import {
  ExternalEchoLedger,
  normalizeRoutedPromptText,
  promptEchoText,
} from "./external-echo-ledger.js";

describe("normalizeRoutedPromptText", () => {
  test("drops the image markers the external CLI renders inline", () => {
    expect(normalizeRoutedPromptText("Look at [Image #1] this[Image #2]")).toBe("Look at  this");
  });

  test("drops the appendix the router adds for attached images", () => {
    const routed =
      "fix the spacing\n\nAttached images (read these files):\n/tmp/prompt-images/a/1-0.png";
    expect(normalizeRoutedPromptText(routed)).toBe("fix the spacing");
  });
});

describe("promptEchoText", () => {
  test("returns a plain prompt unchanged", () => {
    expect(promptEchoText("ship it")).toBe("ship it");
  });

  test("joins the text blocks of a structured prompt and skips images", () => {
    expect(
      promptEchoText([
        { type: "text", text: "first" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });
});

describe("ExternalEchoLedger", () => {
  test("consumes a recorded prompt exactly once", () => {
    const ledger = new ExternalEchoLedger();
    ledger.record("merge it");

    expect(ledger.consume("merge it")).toBe(true);
    expect(ledger.consume("merge it")).toBe(false);
    expect(ledger.pendingCount).toBe(0);
  });

  test("two deliveries of the same text owe two echoes", () => {
    const ledger = new ExternalEchoLedger();
    ledger.record("/compact");
    ledger.record("/compact");

    expect(ledger.consume("/compact")).toBe(true);
    expect(ledger.consume("/compact")).toBe(true);
    expect(ledger.consume("/compact")).toBe(false);
  });

  test("leaves a message the external process originated alone", () => {
    const ledger = new ExternalEchoLedger();
    ledger.record("merge it");

    expect(ledger.consume("something typed in the pane")).toBe(false);
    expect(ledger.pendingCount).toBe(1);
  });

  test("matches an echo decorated on its way through the external process", () => {
    const ledger = new ExternalEchoLedger();
    ledger.record("fix the spacing");

    expect(
      ledger.consume(
        "fix the spacing[Image #1]\n\nAttached images (read these files):\n/tmp/a/1-0.png",
      ),
    ).toBe(true);
  });

  test("matches an echo the external process appended to", () => {
    const ledger = new ExternalEchoLedger();
    ledger.record("run the tests");

    expect(ledger.consume("run the tests\nand report back")).toBe(true);
  });

  test("records nothing for a prompt with no text", () => {
    const ledger = new ExternalEchoLedger();
    ledger.record("   ");

    expect(ledger.pendingCount).toBe(0);
  });

  test("forgets an echo that never arrived, so the next message still renders", () => {
    let now = 1_000_000;
    const ledger = new ExternalEchoLedger(() => now);
    ledger.record("merge it");

    now += 600_001;
    expect(ledger.consume("merge it")).toBe(false);
    expect(ledger.pendingCount).toBe(0);
  });

  test("keeps an echo that is still inside the window", () => {
    let now = 1_000_000;
    const ledger = new ExternalEchoLedger(() => now);
    ledger.record("merge it");

    now += 599_000;
    expect(ledger.consume("merge it")).toBe(true);
  });
});
