/**
 * "Some of what you are looking at was written by the installer."
 *
 * A demo install (ATHENA_SEED_SAMPLE_DATA=1; a default install writes none)
 * seeds three clients, four sites and three tests so the app has something to
 * show. Two of those tests carry severity counts, and the dashboard adds them
 * into its totals -- so it reported twenty-three findings and three criticals
 * against an estate nobody had scanned. Every one of those figures was derived from a real database row,
 * which is exactly what made it convincing and exactly why it had to stop.
 *
 * So the notice states the numbers rather than hedging. "Some of this is
 * sample data" is the kind of sentence a reader discounts; "23 of the
 * findings below were written by the installer" is one they act on. And the
 * button beside it is the point: a claim like this is only worth making if it
 * comes with the means to make it false.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { FlaskConical, Trash2 } from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateTestsAndFindings } from "@/lib/invalidate";
import { isAdmin } from "@/utils/auth";
import { loaded } from "@/lib/loaded";
import type { PublicUser, SampleDataCounts } from "@shared/schema";

/**
 * Everything a removal changes, so no screen keeps showing what is gone. Each
 * is a key a page reads (tests/every-page-query-key-reaches-a-route.test.ts):
 * "/api/activity-logs" was listed here, and nothing reads or serves it.
 */
const AFFECTED = [
  "/api/sample-data",
  "/api/clients",
  "/api/sites",
  "/api/tests",
  "/api/documents",
];

interface SampleDataNoticeProps {
  /**
   * What this screen counts. The dashboard sums findings, so it says how many
   * of them are seeded; a list of clients says how many clients are.
   */
  counts: Array<keyof SampleDataCounts>;
  className?: string;
}

const NOUNS: Record<keyof SampleDataCounts, [string, string]> = {
  clients: ["client", "clients"],
  sites: ["site", "sites"],
  tests: ["test", "tests"],
  documents: ["document", "documents"],
  findings: ["finding", "findings"],
};

/** "clients, tests and findings": what this screen counts, by name. */
function nounList(keys: Array<keyof SampleDataCounts>): string {
  const names = keys.map((key) => NOUNS[key][1]);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "3 clients, 4 sites and 23 findings", or "" when none of them are seeded. */
function phrase(counts: SampleDataCounts, keys: Array<keyof SampleDataCounts>) {
  const present = keys.filter((key) => counts[key] > 0);
  const parts = present.map((key) => {
    const [one, many] = NOUNS[key];
    return `${counts[key]} ${counts[key] === 1 ? one : many}`;
  });
  const said =
    parts.length === 0
      ? ""
      : parts.length === 1
        ? parts[0]
        : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  // Plural unless the whole phrase names exactly one thing, so the sentence
  // reads "1 test was" and "3 tests were" rather than always one of them.
  const plural = present.length > 1 || present.some((key) => counts[key] !== 1);
  return { said, plural, mentionsFindings: present.includes("findings") };
}

export default function SampleDataNotice({
  counts,
  className,
}: SampleDataNoticeProps) {
  const { toast } = useToast();

  // Read error-first (lib/loaded.ts). A count that could not be read is not a
  // count of zero: returning nothing on a failed read took the disclosure off
  // every screen of a demo install at once, so the seeded rows rendered
  // unlabelled. Nor is a count read before a refetch failed still current.
  const counted = loaded(useQuery<SampleDataCounts>({ queryKey: ["/api/sample-data"] }));

  // Asked here rather than threaded down from the router, so the notice can be
  // dropped onto a screen without that screen having to know who is signed in.
  // The button is a convenience either way: the server refuses a non-admin.
  const { data: session } = useQuery<{ authenticated: boolean; user: PublicUser | null }>({
    queryKey: ["/api/auth/check"],
  });
  const canRemove = isAdmin(session?.user ?? null);

  const remove = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("DELETE", "/api/sample-data", undefined);
      return (await response.json()) as { removed: SampleDataCounts };
    },
    onSuccess: (result) => {
      for (const key of AFFECTED) queryClient.invalidateQueries({ queryKey: [key] });
      // The seeded tests' counts reached the findings summary (the untracked
      // caveat on the Overview), which outlived the notice until now.
      void invalidateTestsAndFindings();
      const { removed } = result;
      toast({
        title: "Sample data removed",
        description:
          `${removed.clients} clients, ${removed.sites} sites, ${removed.tests} tests ` +
          `and ${removed.documents} documents are gone. Nothing else was touched.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Not removed", description: error.message, variant: "destructive" });
    },
  });

  if (counted.state === "loading") return null;
  if (counted.state === "error") {
    return (
      <div
        className={`athena-panel flex items-start gap-3 p-4 ${className ?? ""}`}
        style={{ borderColor: "hsl(var(--gold) / 0.4)" }}
        data-testid="notice-sample-data"
        data-state="unchecked"
      >
        <FlaskConical className="athena-gold mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <div className="athena-label athena-gold">Sample data</div>
          <p className="mt-1 text-sm text-muted-foreground">
            Could not check for installer sample rows: {counted.message}. If this install was seeded for a demo
            (ATHENA_SEED_SAMPLE_DATA), some of the {nounList(counts)} on this screen may have been written by the
            installer rather than recorded from any system.
          </p>
        </div>
      </div>
    );
  }
  const { said, plural, mentionsFindings } = phrase(counted.data, counts);
  // Nothing seeded is still on this screen, so there is nothing to disclose.
  if (said === "") return null;

  return (
    <div
      className={`athena-panel flex flex-wrap items-center justify-between gap-4 p-4 ${className ?? ""}`}
      style={{ borderColor: "hsl(var(--gold) / 0.4)" }}
      data-testid="notice-sample-data"
    >
      <div className="flex min-w-0 flex-1 basis-[30rem] items-start gap-3">
        <FlaskConical className="athena-gold mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <div className="athena-label athena-gold">Sample data</div>
          <p className="mt-1 text-sm text-muted-foreground">
            {said} on this screen {plural ? "were" : "was"} written by the
            installer for a demo (ATHENA_SEED_SAMPLE_DATA), not recorded
            from any system.
            {/* Only where it is true and load-bearing. A scan does not
                produce a client, so saying so on the clients screen is
                filler; on a screen showing severity counts it is the
                whole point. */}
            {mentionsFindings && " No scan produced those findings."}
          </p>
        </div>
      </div>
      {canRemove && (
        <button
          type="button"
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
          className="athena-label inline-flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-muted-foreground transition-colors hover:text-destructive"
          style={{ borderColor: "hsl(var(--border))" }}
          data-testid="button-remove-sample-data"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {remove.isPending ? "Removing…" : "Remove it"}
        </button>
      )}
    </div>
  );
}
