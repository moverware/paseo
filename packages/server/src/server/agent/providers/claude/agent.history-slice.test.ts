import { describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import { sliceHistoryToRecentTurns } from "./agent.js";

interface Entry {
  item: AgentTimelineItem;
}

function user(text: string): Entry {
  return { item: { type: "user_message", text } };
}

function assistant(text: string): Entry {
  return { item: { type: "assistant_message", text } };
}

function texts(entries: Entry[]): string[] {
  return entries.map((entry) => ("text" in entry.item ? entry.item.text : ""));
}

describe("sliceHistoryToRecentTurns", () => {
  test("keeps everything when the history holds fewer turns than the cap", () => {
    const history = [user("one"), assistant("a"), user("two"), assistant("b")];

    expect(sliceHistoryToRecentTurns(history, 20)).toEqual(history);
  });

  test("starts at the user message that opens the oldest kept turn", () => {
    const history = [
      user("one"),
      assistant("a"),
      user("two"),
      assistant("b"),
      user("three"),
      assistant("c"),
    ];

    expect(texts(sliceHistoryToRecentTurns(history, 2))).toEqual(["two", "b", "three", "c"]);
  });

  test("drops everything before the first kept user message, replies included", () => {
    const history = [assistant("a stray reply"), user("one"), assistant("a")];

    expect(texts(sliceHistoryToRecentTurns(history, 1))).toEqual(["one", "a"]);
  });

  test("keeps a history with no user messages whole", () => {
    const history = [assistant("a"), assistant("b")];

    expect(sliceHistoryToRecentTurns(history, 1)).toEqual(history);
  });

  test("keeps trailing items after the last user message", () => {
    const history = [user("one"), assistant("a"), user("two"), assistant("b"), assistant("c")];

    expect(texts(sliceHistoryToRecentTurns(history, 1))).toEqual(["two", "b", "c"]);
  });
});
