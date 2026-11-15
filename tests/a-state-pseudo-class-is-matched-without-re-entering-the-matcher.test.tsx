// @vitest-environment jsdom
/**
 * A state pseudo-class (`:modal`, `:popover-open`, `:open`, ...) is matched in
 * jsdom by one call to `Element.matches`, never by `matches` calling itself.
 *
 * Why this is a test: nwsapi 2.2.27, the selector engine jsdom uses, answered
 * a state pseudo-class by asking the element's own `matches` for it. In jsdom
 * that `matches` is nwsapi again, so the question re-entered itself until the
 * stack ran out, and the RangeError was swallowed: the answer was right
 * (false) and every call cost a full stack of recursion. floating-ui asks
 * `:popover-open` and `:modal` of every element it positions against, each
 * time it positions, and the app's Select, menus and tooltips are positioned
 * by it (Radix's popper). Opening the Tests screen's status filter in
 * tests/a-scan-not-known-to-the-engine-is-shown-and-counted-under-its-own-label.test.tsx
 * held its worker's event loop for 22 s in one synchronous act() on a Linux
 * host, and for over 60 s on the windows-latest runner. A worker blocked that
 * long misses vitest's 60 s reply timer on the task update it sent just
 * before ("[vitest-worker]: Timeout calling onTaskUpdate"): the file's last
 * result is never sent, two unhandled errors are reported, and the job fails
 * with every test passed. nwsapi 2.2.28 holds a guard against the re-entry.
 *
 * The count is of calls, not of time, so it says the same on any runner.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const STATE_PSEUDO_CLASSES = [":modal", ":popover-open", ":open", ":closed", ":fullscreen", ":picture-in-picture"];

/** Every call to `Element.matches` while `run` runs: how many, and how deep they nested. */
async function countMatches(run: () => void | Promise<void>): Promise<{ calls: number; deepest: number; selectors: Set<string> }> {
  const proto = window.Element.prototype;
  const original = proto.matches;
  let calls = 0;
  let depth = 0;
  let deepest = 0;
  const selectors = new Set<string>();
  proto.matches = function matches(this: Element, selector: string): boolean {
    calls += 1;
    depth += 1;
    deepest = Math.max(deepest, depth);
    selectors.add(selector);
    try {
      return original.call(this, selector);
    } finally {
      depth -= 1;
    }
  };
  try {
    await run();
  } finally {
    proto.matches = original;
  }
  return { calls, deepest, selectors };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("a state pseudo-class in jsdom", () => {
  for (const selector of STATE_PSEUDO_CLASSES) {
    it(`${selector} is answered by one call to matches, which does not call itself`, async () => {
      const element = document.createElement("div");
      // A popover, so `:popover-open` asks for its state too.
      element.setAttribute("popover", "");
      document.body.append(element);
      let answer: boolean | undefined;
      const seen = await countMatches(() => {
        answer = element.matches(selector);
      });
      expect(answer).toBe(false);
      expect(seen.calls).toBe(1);
      expect(seen.deepest).toBe(1);
    });
  }

  it("opening the app's Select, and the floating-ui positioning that follows, never nests one matches call in another", async () => {
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    window.HTMLElement.prototype.scrollIntoView ??= () => {};
    window.HTMLElement.prototype.hasPointerCapture ??= () => false;
    window.HTMLElement.prototype.releasePointerCapture ??= () => {};
    render(
      <Select defaultValue="all">
        <SelectTrigger data-testid="trigger"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          <SelectItem value="one" data-testid="option-one">One</SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = screen.getByTestId("trigger");
    const seen = await countMatches(async () => {
      act(() => {
        trigger.focus();
        fireEvent.keyDown(trigger, { key: "ArrowDown" });
      });
      // floating-ui positions the content after the open, in promises the
      // open's act() does not wait on: the content is placed once it has run.
      await waitFor(() => {
        const wrapper = document.querySelector<HTMLElement>("[data-radix-popper-content-wrapper]");
        expect(wrapper?.style.transform).toMatch(/^translate\(\d/);
      });
      act(() => {
        fireEvent.click(screen.getByTestId("option-one"));
      });
    });
    expect(trigger.textContent).toBe("One");
    // floating-ui did ask whether an element is in the top layer: the path this guards was taken.
    expect([...seen.selectors].filter((one) => one === ":modal" || one === ":popover-open").sort()).toEqual([":modal", ":popover-open"]);
    expect(seen.deepest).toBe(1);
  });
});
