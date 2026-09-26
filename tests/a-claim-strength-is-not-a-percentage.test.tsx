// @vitest-environment jsdom
/**
 * A claim's confidence is an ordinal strength, not a probability.
 *
 * athena-backend reads it from the weakest class of evidence behind the claim --
 * `round(max(0.1, 1.0 - 0.12 * rank), 2)`, 1.00 for technically verified down to
 * 0.16 for not documented and 0.10 at the floor -- and mythos-core documents that
 * table with the basis "ordinal ... Not a probability that the claim is true". The
 * claims panel printed it as "conf 52%", which reads as a 52% chance the claim is
 * true.
 *
 * And the backend grades the machine's reading, not a status a person set: a claim
 * a person moves to contradicted keeps the 0.52 it had while supported, and one a
 * person moves up from unknown keeps none. So the panel shows a strength only
 * beside a status that stands on supporting evidence, only while that evidence
 * has not expired, and only while no retest is due: a person can move a claim a
 * change invalidated back to supported before any retest, and it keeps its 0.52.
 * While the retest requirements are being read -- for the first time, or again
 * while the read in hand is older than the claims -- or could not be read, it is
 * not shown either.
 *
 * Where it shows none, the reason it gives is what the status means in the
 * backend, true on every path that sets it -- never a cause. A person can mark a
 * claim contradicted over evidence that supports it, or unknown over evidence that
 * contradicts it, a derived unknown can be partly known, and stale means a retest
 * is due, whether a system change, a declared condition or expiry put it there.
 */
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  CLAIM_STRENGTH_BASIS,
  CLAIM_STRENGTH_READING,
  ClaimsPanel,
  claimStrength,
  claimStrengthBasis,
} from "@/pages/Assurance";

afterEach(cleanup);

const SUPPORTING = ["supported", "verified", "partially_verified"] as const;
const RETEST_STATES = [false, true, null] as const;

const RETEST_DUE = "No strength: a retest is due before this claim can be read as current.";
const REASON: Record<string, string> = {
  contradicted: "No strength: this claim is marked contradicted.",
  unknown: "No strength: this claim is marked unknown.",
  revoked: "No strength: this claim was withdrawn.",
  stale: RETEST_DUE,
  superseded: "No strength: a newer version of this claim replaces it.",
  draft: "No strength: this claim has not been assessed.",
};
const UNRECOGNISED = "No strength: this console does not recognise this claim's status.";
const EXPIRED = "No strength: the evidence behind this claim has expired.";
const UNRECORDED = "No strength recorded for this claim.";
const OFF_SCALE = "No strength: the recorded value is not on the evidence-strength scale (0.10 to 1.00).";
const RETEST_UNREAD = "No strength: whether a retest is due for this claim could not be read.";

describe("a claim's strength", () => {
  it("is printed as the ordinal the backend sent, never as a percentage", () => {
    for (const [value, text] of [
      [1, "strength 1.00"],
      [0.52, "strength 0.52"],
      [0.16, "strength 0.16"],
      [0.1, "strength 0.10"],
    ] as const) {
      for (const status of SUPPORTING) {
        const c = { status, confidence: value, isStale: false, retestDue: false };
        expect(claimStrength(c)).toBe(text);
        expect(claimStrengthBasis(c)).toBe(CLAIM_STRENGTH_BASIS);
      }
    }
    expect(CLAIM_STRENGTH_BASIS).toBe(
      "Ordinal: read from the weakest class of evidence supporting the claim. Not a probability that the claim is true.",
    );
  });

  it("is never shown beside a status that does not stand on supporting evidence, and says what that status means", () => {
    for (const status of [...Object.keys(REASON), "odd", "constructor"]) {
      for (const isStale of [false, true]) {
        for (const retestDue of RETEST_STATES) {
          const c = { status, confidence: 0.52, isStale, retestDue };
          expect(claimStrength(c)).toBe("strength —");
          expect(claimStrengthBasis(c)).toBe(Object.hasOwn(REASON, status) ? REASON[status] : UNRECOGNISED);
        }
      }
    }
    // A person can mark a claim contradicted over evidence that supports it, or
    // unknown over evidence that contradicts it: neither reason may say what the
    // evidence shows, and unknown may not say it is neither supported nor contradicted.
    const basis = (status: string) => claimStrengthBasis({ status, confidence: 0.52, isStale: false, retestDue: false });
    expect(basis("contradicted")).not.toMatch(/evidence|nothing is known/);
    expect(basis("unknown")).not.toMatch(/supported|contradicted|evidence/);
    // Stale means a retest is due; only one of the three paths to it is expiry.
    expect(basis("stale")).not.toContain("expired");
    // A status this console does not know: it says only that.
    expect(basis("odd")).toBe("No strength: this console does not recognise this claim's status.");
  });

  it("is not shown while a retest is due, or while that could not be read, under any supporting status", () => {
    for (const status of SUPPORTING) {
      for (const confidence of [1, 0.52, 0.1]) {
        const due = { status, confidence, isStale: false, retestDue: true };
        expect(claimStrength(due)).toBe("strength —");
        // The same words as the stale status: that is what an open retest means.
        expect(claimStrengthBasis(due)).toBe(RETEST_DUE);

        const unread = { status, confidence, isStale: false, retestDue: null };
        expect(claimStrength(unread)).toBe("strength —");
        expect(claimStrengthBasis(unread)).toBe(RETEST_UNREAD);

        const none = { status, confidence, isStale: false, retestDue: false };
        expect(claimStrength(none)).toBe(`strength ${confidence.toFixed(2)}`);
        expect(claimStrengthBasis(none)).toBe(CLAIM_STRENGTH_BASIS);
      }
    }
  });

  it("is not shown once the evidence behind it has expired, under any supporting status", () => {
    for (const status of SUPPORTING) {
      for (const confidence of [1, 0.52, 0.1, null]) {
        for (const retestDue of RETEST_STATES) {
          const c = { status, confidence, isStale: true, retestDue };
          expect(claimStrength(c)).toBe("strength —");
          expect(claimStrengthBasis(c)).toBe(EXPIRED);
        }
      }
    }
  });

  it("is absent, not zero, where none was recorded", () => {
    // NaN is not a number: nothing that is a strength was recorded.
    for (const value of [null, undefined, Number.NaN]) {
      for (const retestDue of RETEST_STATES) {
        const c = { status: "supported", confidence: value as number | null, isStale: false, retestDue };
        expect(claimStrength(c)).toBe("strength —");
        expect(claimStrengthBasis(c)).toBe(UNRECORDED);
      }
    }
  });

  it("is not printed off the backend's scale of 0.10 to 1.00, and says a value was recorded", () => {
    // 0.004 would print "strength 0.00"; 52 is a percentage; 1.5 and the rest are
    // out of range. Each is a recorded number, so "none recorded" would be false.
    for (const value of [0, 0.004, 0.0999, -0.001, 1.5, 52, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const status of SUPPORTING) {
        for (const retestDue of RETEST_STATES) {
          const c = { status, confidence: value, isStale: false, retestDue };
          expect(claimStrength(c)).toBe("strength —");
          expect(claimStrengthBasis(c)).toBe(OFF_SCALE);
        }
      }
    }
  });
});

const KEY = "/api/assurance/deployments/dep/assurance-claims";
// The open retest requirements: the query the retest obligations panel makes too.
const RETESTS_KEY = ["/api/assurance/deployments/dep/retest-requirements", {}];

function claim(
  uuid: string,
  status: string,
  statusLabel: string,
  confidence: number | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    uuid,
    deploymentUuid: "dep",
    assetUuid: null,
    assetName: null,
    claimType: "data_boundary",
    claimTypeLabel: `Data boundary (${uuid})`,
    statement: "Customer data stays in-region.",
    fingerprint: `fp-${uuid}`,
    systemFingerprint: "sys",
    policyVersion: "v1",
    environment: "prod",
    environmentLabel: "Production",
    status,
    statusLabel,
    evidenceClass: "vendor_asserted",
    evidenceClassLabel: "Vendor asserted",
    confidence,
    vendorAsserted: true,
    assessment: null,
    assessmentLabel: null,
    supportingSummary: "",
    contradictingSummary: "",
    invalidationConditions: [],
    supersededBy: null,
    humanOwner: null,
    receiptDigest: "",
    isStale: false,
    validFrom: null,
    validTo: null,
    verifiedAt: null,
    expiration: null,
    firstSeen: null,
    lastSeen: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

/** A retest requirement as the BFF maps it (backend RetestRequirementSerializer). */
function requirement(claimUuid: string, claimType: string, isOpen = true) {
  return {
    uuid: `rr-${claimUuid}`,
    deploymentUuid: "dep",
    claimUuid,
    claimType,
    claimTypeLabel: claimType,
    resolvingClaimUuid: null,
    reason: "The inputs this claim rests on changed; the state this claim was true of no longer matches the deployment.",
    triggeringSystemFingerprint: "t".repeat(16),
    actor: null,
    isOpen,
    openedAt: "2026-09-26T00:00:00Z",
    resolvedAt: isOpen ? null : "2026-09-26T01:00:00Z",
    createdAt: null,
    updatedAt: null,
  };
}

const REQUIREMENTS = [
  // Open, on row i's own version: a change invalidated it and a person moved it
  // back to supported before any retest.
  requirement("i", "data_boundary"),
  // Open, on a version of an effective-access claim this list does not hold.
  requirement("gone", "effective_access"),
  // Resolved: no retest is due for row a.
  requirement("a", "data_boundary", false),
];

type Retests = "read" | "reading" | "error";

interface MountOptions {
  /** The open retest requirements already read (with `retests` "read"). */
  requirements?: unknown[];
  /** When the claims and the requirements in hand were read: now, claims first, unless given. */
  claimsReadAt?: number;
  retestsReadAt?: number;
  /** What reading them again answers: the same claims, and requirements that never come or fail. */
  reread?: "slow" | "fail";
  admin?: boolean;
}

function mount(rows: { uuid: string }[], retests: Retests = "read", options: MountOptions = {}) {
  const { requirements = REQUIREMENTS, claimsReadAt, retestsReadAt, reread, admin = false } = options;
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          if (queryKey[0] === KEY && reread) return rows;
          if (queryKey[0] === RETESTS_KEY[0] && (retests === "reading" || reread === "slow")) return new Promise(() => {});
          if (queryKey[0] === RETESTS_KEY[0] && (retests === "error" || reread === "fail")) {
            throw new Error("the control plane is unavailable");
          }
          throw new Error(`unexpected fetch for ${String(queryKey[0])}`);
        },
      },
    },
  });
  client.setQueryData([KEY], rows, { updatedAt: claimsReadAt });
  if (retests === "read") client.setQueryData(RETESTS_KEY, requirements, { updatedAt: retestsReadAt });
  // Each row's lifecycle, fetched when the row is expanded.
  for (const row of rows) client.setQueryData([`/api/assurance/claims/${row.uuid}/events`], []);
  render(
    <QueryClientProvider client={client}>
      <ClaimsPanel deploymentUuid="dep" admin={admin} />
    </QueryClientProvider>,
  );
  return client;
}

/** The row's text with the screen-reader-only text taken out: what is on screen. */
function visibleText(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll(".sr-only").forEach((node) => node.remove());
  return copy.textContent ?? "";
}

/** No percentage anywhere in the row: not in its text, not in any attribute, not as a meter or bar. */
function expectNoPercentage(li: Element) {
  expect(li.textContent).not.toContain("%");
  for (const node of [li, ...Array.from(li.querySelectorAll("*"))]) {
    for (const attr of Array.from(node.attributes)) expect(`${attr.name}=${attr.value}`).not.toContain("%");
  }
  expect(li.querySelector("meter, progress, [role=meter], [role=progressbar]")).toBeNull();
}

/** Nothing from `el` up to its row hides it from a screen reader or from the screen. */
function expectNotHiddenInRow(el: Element, li: Element) {
  for (let node: Element | null = el; node && li.contains(node); node = node.parentElement) {
    expect(node.hasAttribute("aria-hidden")).toBe(false);
    expect(node.hasAttribute("hidden")).toBe(false);
  }
}

/** A row's strength: the value on screen, the basis as its title and, for a screen reader, in its text. */
function expectStrength(li: Element, value: string, basis: string) {
  const span = within(li).getByTestId("text-claim-strength");
  const valueSpan = within(li).getByTestId("text-claim-strength-value");
  expect(valueSpan.textContent).toBe(value);
  expect(span.getAttribute("title")).toBe(basis);
  expect(visibleText(li)).toContain(value);
  expectNotHiddenInRow(valueSpan, li);

  // What a screen reader reads: the basis, in text that is only off screen.
  const sr = within(li).getByTestId("text-claim-strength-sr");
  expect(sr.className).toBe("sr-only");
  expectNotHiddenInRow(sr, li);
  expect(sr.textContent).toBe(` (${basis})`);
  expect(span.textContent).toBe(`${value} (${basis})`);

  expectNoPercentage(li);
}

/** A collapsed row: its strength, and the basis nowhere on screen. */
function expectCollapsed(li: Element, value: string, basis: string) {
  expect(within(li).getByRole("button", { expanded: false })).toBeTruthy();
  expectStrength(li, value, basis);
  expect(visibleText(li)).not.toContain(basis);
  expect(within(li).queryByTestId("text-claim-strength-basis")).toBeNull();
}

/** An expanded row: its strength, and the same basis on screen. */
function expectExpanded(li: Element, value: string, basis: string) {
  expect(within(li).getByRole("button", { expanded: true })).toBeTruthy();
  expectStrength(li, value, basis);
  const p = within(li).getByTestId("text-claim-strength-basis");
  expect(p.textContent).toBe(basis);
  expect(p.className).not.toMatch(/\bsr-only\b|\bhidden\b|\binvisible\b/);
  expectNotHiddenInRow(p, li);
  expect(visibleText(li)).toContain(basis);
}

function rowsOnScreen(): Element[] {
  return screen.getAllByTestId("text-claim-strength").map((span) => span.closest("li")!);
}

function expand(items: Element[]) {
  for (const li of items) fireEvent.click(within(li).getByRole("button", { expanded: false }));
}

// What each fixture row must print, and why it is there. `waits` marks a row whose
// strength waits on the retest requirements; no other reason does.
const ROWS: { row: ReturnType<typeof claim>; value: string; basis: string; waits?: boolean }[] = [
  // Only a resolved requirement names it.
  { row: claim("a", "supported", "Supported", 0.52), value: "strength 0.52", basis: CLAIM_STRENGTH_BASIS, waits: true },
  {
    // Moved to contradicted by a person over evidence that supports the claim:
    // the backend still carries the machine's 0.52 and its supporting summary.
    row: claim("b", "contradicted", "Contradicted", 0.52, {
      supportingSummary: "2 of 2 data flow(s) reconciled within the approved boundary.",
    }),
    value: "strength —",
    basis: REASON.contradicted,
  },
  { row: claim("c", "revoked", "Revoked", 0.52), value: "strength —", basis: REASON.revoked },
  // Moved up from unknown by a person: the backend carries no strength.
  { row: claim("d", "supported", "Supported", null), value: "strength —", basis: UNRECORDED },
  {
    // Derived unknown and partly known, with a contradicting line on the row.
    row: claim("e", "unknown", "Unknown", null, {
      evidenceClass: "unknown",
      evidenceClassLabel: "Unknown",
      supportingSummary: "1 of 2 data flow(s) reconciled within the approved boundary.",
      contradictingSummary: "1 flow(s) with an undeclared posture.",
    }),
    value: "strength —",
    basis: REASON.unknown,
  },
  {
    // A derived contradicted claim a person moved to unknown: configuration-verified
    // evidence and a contradicting line, so "neither supported nor contradicted" was false.
    row: claim("f", "unknown", "Unknown", null, {
      evidenceClass: "configuration_verified",
      evidenceClassLabel: "Configuration verified",
      vendorAsserted: false,
      contradictingSummary: "1 flow(s) outside the boundary.",
    }),
    value: "strength —",
    basis: REASON.unknown,
  },
  // Marked stale (a retest is due); the backend leaves the 0.52 in place.
  { row: claim("g", "stale", "Stale", 0.52), value: "strength —", basis: REASON.stale },
  {
    // Supported, but its evidence has expired.
    row: claim("h", "supported", "Supported", 0.52, { isStale: true }),
    value: "strength —",
    basis: EXPIRED,
  },
  // Supported with an open retest requirement: invalidated by a change, then moved
  // back to supported by a person. The backend caps the decision with
  // retest_pending and still sends the 0.52.
  { row: claim("i", "supported", "Supported", 0.52), value: "strength —", basis: RETEST_DUE, waits: true },
  {
    // An open requirement names a version of an effective-access claim that is not
    // in the list: which current claim it binds cannot be read from it.
    row: claim("j", "supported", "Supported", 0.52, {
      claimType: "effective_access",
      claimTypeLabel: "Effective access (j)",
    }),
    value: "strength —",
    basis: RETEST_UNREAD,
    waits: true,
  },
  // A value recorded off the scale: 0.004 would print "strength 0.00".
  { row: claim("k", "supported", "Supported", 0.004), value: "strength —", basis: OFF_SCALE },
  // A status the backend does not have.
  { row: claim("l", "odd", "Odd", 0.52), value: "strength —", basis: UNRECOGNISED },
];

describe("the claims panel", () => {
  it("prints each claim's strength as the ordinal, with its basis, and never as a percentage", () => {
    mount(ROWS.map((r) => r.row));
    const items = rowsOnScreen();
    expect(items).toHaveLength(ROWS.length);

    items.forEach((li, i) => {
      const { row, value, basis } = ROWS[i];
      expect(within(li).getByText(row.claimTypeLabel)).toBeTruthy();
      expectCollapsed(li, value, basis);
    });

    // A stale row keeps its stale mark beside the absent strength.
    expect(within(items[ROWS.findIndex((r) => r.row.uuid === "h")]).getByText("stale")).toBeTruthy();
  });

  it("gives the same basis in each claim's expanded section, on screen, and no percentage there either", () => {
    mount(ROWS.map((r) => r.row));
    const items = rowsOnScreen();
    expand(items);

    items.forEach((li, i) => {
      const { value, basis } = ROWS[i];
      expectExpanded(li, value, basis);
      // The seeded lifecycle rendered, so nothing was fetched.
      expect(within(li).getByText("No lifecycle events recorded yet.")).toBeTruthy();
    });
  });

  it("shows no strength that waits on the retest requirements while they are being read", () => {
    mount(ROWS.map((r) => r.row), "reading");
    const items = rowsOnScreen();
    items.forEach((li, i) => {
      const { value, basis, waits } = ROWS[i];
      if (waits) expectCollapsed(li, "strength —", CLAIM_STRENGTH_READING);
      else expectCollapsed(li, value, basis);
    });
    expand(items);
    items.forEach((li, i) => {
      const { value, basis, waits } = ROWS[i];
      if (waits) expectExpanded(li, "strength —", CLAIM_STRENGTH_READING);
      else expectExpanded(li, value, basis);
    });
    expect(CLAIM_STRENGTH_READING).toBe("No strength yet: whether a retest is due for this claim is still being read.");
  });

  it("shows no strength that waits on the retest requirements when they could not be read, and says so", async () => {
    mount(ROWS.map((r) => r.row), "error");
    const items = rowsOnScreen();
    await waitFor(() =>
      expect(within(items[0]).getByTestId("text-claim-strength").getAttribute("title")).toBe(RETEST_UNREAD),
    );
    items.forEach((li, i) => {
      const { value, basis, waits } = ROWS[i];
      if (waits) expectCollapsed(li, "strength —", RETEST_UNREAD);
      else expectCollapsed(li, value, basis);
    });
    expand(items);
    items.forEach((li, i) => {
      const { value, basis, waits } = ROWS[i];
      if (waits) expectExpanded(li, "strength —", RETEST_UNREAD);
      else expectExpanded(li, value, basis);
    });
  });

  it("keeps a claim its own open requirement names due beside one on a version of its type the list does not hold", () => {
    // The requirement on an unlisted data-boundary version leaves every other
    // data-boundary claim unread; the one its own open requirement names is due.
    mount([claim("i", "supported", "Supported", 0.52), claim("m", "supported", "Supported", 0.52)], "read", {
      requirements: [requirement("gone", "data_boundary"), requirement("i", "data_boundary")],
    });
    const [i, m] = rowsOnScreen();
    expectCollapsed(i, "strength —", RETEST_DUE);
    expectCollapsed(m, "strength —", RETEST_UNREAD);
  });

  it("expands a claim whose status is named like an object key for an admin, and offers it no moves", () => {
    // `CLAIM_TRANSITIONS.constructor` is Object: read as the list of moves, it
    // crashed the panel when an admin expanded the row.
    const odd = ["constructor", "hasOwnProperty", "toString", "__proto__"];
    mount(
      [
        claim("s", "supported", "Supported", 0.52),
        ...odd.map((status, n) => claim(`o${n}`, status, status, 0.52)),
      ],
      "read",
      { requirements: [], admin: true },
    );
    const items = rowsOnScreen();
    expand(items);
    // A status the backend has: its legal moves.
    const moves = within(items[0]).getByRole("combobox", { name: "Move claim to" });
    expect(within(moves).getAllByRole("option").map((o) => o.getAttribute("value"))).toEqual([
      "",
      "verified",
      "partially_verified",
      "contradicted",
      "unknown",
      "revoked",
    ]);
    // One it does not have: no moves, and the reason it has no strength.
    for (const li of items.slice(1)) {
      expect(within(li).queryByRole("combobox", { name: "Move claim to" })).toBeNull();
      expectExpanded(li, "strength —", UNRECOGNISED);
    }
  });
});

describe("the claims panel, when the claims and the retest requirements are read again", () => {
  const MINUTE = 60_000;

  /** The query client tells the panel what changed on a later tick: let it, and the panel render it. */
  async function settle() {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  }

  /**
   * A person moves a claim a change invalidated back to supported before the
   * requirements read after that change lands. The panel reads both again, as
   * `invalidateAssuranceComputed` does after every change, and the claims land
   * first. Returns the row and what sends the requirements that read answers.
   */
  async function movedBackBeforeTheRetestReadLands() {
    // What the control plane answers: the claim as it stands, and requirements
    // that arrive only when the test sends them.
    let claims = [claim("c1", "supported", "Supported", 0.52)];
    let answerRetests: (requirements: unknown[]) => void = () => {
      throw new Error("no read of the retest requirements is waiting");
    };
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Infinity,
          gcTime: Infinity,
          queryFn: async ({ queryKey }) => {
            if (queryKey[0] === KEY) return claims;
            if (queryKey[0] === RETESTS_KEY[0]) return new Promise((resolve) => (answerRetests = resolve));
            throw new Error(`unexpected fetch for ${String(queryKey[0])}`);
          },
        },
      },
    });
    // The page as read a minute ago: supported, and no retest open.
    client.setQueryData([KEY], claims, { updatedAt: Date.now() - MINUTE });
    client.setQueryData(RETESTS_KEY, [], { updatedAt: Date.now() - MINUTE });
    client.setQueryData(["/api/assurance/claims/c1/events"], []);
    render(
      <QueryClientProvider client={client}>
        <ClaimsPanel deploymentUuid="dep" admin={false} />
      </QueryClientProvider>,
    );
    const row = () => rowsOnScreen()[0];
    expectCollapsed(row(), "strength 0.52", CLAIM_STRENGTH_BASIS);

    // An admin runs the invalidation check: a retest opens on c1, and c1 goes
    // stale. Both are read again; the requirements are slow.
    claims = [claim("c1", "stale", "Stale", 0.52)];
    await act(async () => void client.invalidateQueries());
    await waitFor(() => expect(within(row()).getByText("Stale")).toBeTruthy());
    expectCollapsed(row(), "strength —", REASON.stale);

    // The admin moves c1 back to supported, and both are read again. The claims
    // land beside requirements read before the retest opened, and still being read.
    claims = [claim("c1", "supported", "Supported", 0.52)];
    await act(async () => void client.invalidateQueries());
    await waitFor(() => expect(within(row()).getByText("Supported")).toBeTruthy());
    expect(client.isFetching({ queryKey: RETESTS_KEY })).toBe(1);
    return { row, answerRetests: (requirements: unknown[]) => answerRetests(requirements) };
  }

  it("shows no strength beside requirements read before the claims while they are read again", async () => {
    const { row, answerRetests } = await movedBackBeforeTheRetestReadLands();
    expectCollapsed(row(), "strength —", CLAIM_STRENGTH_READING);
    expand([row()]);
    expectExpanded(row(), "strength —", CLAIM_STRENGTH_READING);

    // The requirements land, and one names c1: a retest is due.
    await act(async () => answerRetests([requirement("c1", "data_boundary")]));
    await waitFor(() => expectExpanded(row(), "strength —", RETEST_DUE));
  });

  it("shows the strength once the requirements read again land and none names the claim", async () => {
    const { row, answerRetests } = await movedBackBeforeTheRetestReadLands();
    expectCollapsed(row(), "strength —", CLAIM_STRENGTH_READING);
    await act(async () => answerRetests([]));
    await waitFor(() => expectCollapsed(row(), "strength 0.52", CLAIM_STRENGTH_BASIS));
  });

  it("gives every claim its own reason while requirements older than the claims are read again", async () => {
    const client = mount(ROWS.map((r) => r.row), "read", {
      claimsReadAt: Date.now(),
      retestsReadAt: Date.now() - MINUTE,
      reread: "slow",
    });
    await act(async () => void client.invalidateQueries({ queryKey: [RETESTS_KEY[0]] }));
    await settle();
    expect(client.isFetching({ queryKey: RETESTS_KEY })).toBe(1);
    rowsOnScreen().forEach((li, i) => {
      const { value, basis, waits } = ROWS[i];
      if (waits) expectCollapsed(li, "strength —", CLAIM_STRENGTH_READING);
      else expectCollapsed(li, value, basis);
    });
  });

  it("keeps each strength while the requirements alone are read again, the read in hand no older than the claims", async () => {
    // As when the retest obligations panel reads them again on its own: the
    // requirements in hand were read with the claims, in the same millisecond.
    const readAt = Date.now() - MINUTE;
    const client = mount(ROWS.map((r) => r.row), "read", { claimsReadAt: readAt, retestsReadAt: readAt, reread: "slow" });
    await act(async () => void client.invalidateQueries({ queryKey: [RETESTS_KEY[0]] }));
    await settle();
    expect(client.isFetching({ queryKey: RETESTS_KEY })).toBe(1);
    rowsOnScreen().forEach((li, i) => expectCollapsed(li, ROWS[i].value, ROWS[i].basis));
  });

  it("reads requirements that landed before the claims, with no read of them in flight, as the newest asked for", () => {
    // Both were read again after one change, and the requirements came back first.
    const readAt = Date.now() - MINUTE;
    const client = mount(ROWS.map((r) => r.row), "read", { claimsReadAt: readAt + 1_000, retestsReadAt: readAt });
    expect(client.isFetching()).toBe(0);
    rowsOnScreen().forEach((li, i) => expectCollapsed(li, ROWS[i].value, ROWS[i].basis));
  });

  it("shows no strength once reading the requirements again fails, rather than the read before", async () => {
    const client = mount(ROWS.map((r) => r.row), "read", { reread: "fail" });
    await act(async () => void client.invalidateQueries());
    const items = rowsOnScreen();
    await waitFor(() =>
      expect(within(items[0]).getByTestId("text-claim-strength").getAttribute("title")).toBe(RETEST_UNREAD),
    );
    expect(client.getQueryState(RETESTS_KEY)?.status).toBe("error");
    // The read before is still held, and names row i: none of it is used.
    expect(client.getQueryData(RETESTS_KEY)).toEqual(REQUIREMENTS);
    items.forEach((li, i) => {
      const { value, basis, waits } = ROWS[i];
      if (waits) expectCollapsed(li, "strength —", RETEST_UNREAD);
      else expectCollapsed(li, value, basis);
    });
  });
});
