/**
 * The classifiers: which models are loaded, and how good anybody has shown
 * them to be.
 *
 * This page used to accept a paragraph of text, wait a second and a half on a
 * timer, and answer "SQL Injection, 92% confident" -- the same label and the
 * same number whatever was typed into it, both written into the source. A
 * confidence figure is the most load-bearing number a security product
 * displays, and that one was decoration.
 *
 * It classifies again, and the second version of this page is the more
 * interesting one, because the first replacement was also wrong.
 *
 * That version said "there is no classification endpoint on the engine yet"
 * and showed only the registry. The endpoint existed the whole time --
 * POST /api/classify-cve, auth-gated, a real TF-IDF model. Absence was
 * asserted without reading the engine's route table, which is the same defect
 * as the invented confidence, arrived at from the opposite direction.
 *
 * So it calls the endpoint. What it will not do is print the answer without
 * the context needed to read it. The model knows five classes, so an input it
 * has no signal for scores exactly one fifth and comes back carrying whichever
 * label wins the tie-break -- always `rce`. Measured: an empty string, "zzzz",
 * "csrf token missing" and "xxe external entity" all answer `rce` at 0.200,
 * because CSRF and XXE are not among the five. Printing that as a finding
 * would be the third version of the same lie.
 *
 * The registry stays below it. How good is it, and measured how, is the
 * question a technical visitor asks, and a 0.28 confidence beside a 0.20 floor
 * is a more honest answer than the 92% this page used to give.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { errorMessage } from "@/lib/loaded";
import { formatDistanceToNow } from "date-fns";
import { Boxes, CircleSlash, FlaskConical, ScanSearch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";

import GlassCard from "@/components/GlassCard";
import PageHeader from "@/components/PageHeader";
import type { Classifier } from "@shared/schema";

/**
 * Where a measured accuracy stops being a good number.
 *
 * Stated rather than felt, because "94%" means nothing without a threshold
 * beside it and every reader invents a different one.
 */
const GOOD_ENOUGH = 90;

function accuracyColour(accuracy: number): string {
  if (accuracy >= GOOD_ENOUGH) return "hsl(var(--primary))";
  if (accuracy >= 75) return "hsl(var(--sev-medium))";
  return "hsl(var(--sev-high))";
}

interface Classification {
  label: string | null;
  /** Null when the engine sent none. Rendered as "not reported", never as 0%. */
  confidence: number | null;
  /** Null when the engine did not send the field. Its own branch, not `false`. */
  informative: boolean | null;
  baseline: number | null;
  classes: string[];
  engineVersion: string | null;
}

/**
 * The answer, rendered so that "no answer" cannot be mistaken for one.
 *
 * The label is shown either way -- hiding it would be its own dishonesty --
 * but at the floor it is presented as what it is: the model expressing no
 * preference, with the tie-break winner attached.
 */
export function Verdict({ result }: { result: Classification }) {
  const floor = result.baseline;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

  if (result.informative === null) {
    // The engine did not say. Neither of the panels below applies: one presents
    // the label as a classification, the other states that the model scored
    // every class equally -- and that is a claim about the model, which an
    // absent field does not support. Rendering it anyway produced a page that
    // contradicted its own numbers, announcing a 20.0% tie beside a measured
    // 0.9. So this says what is actually known and stops.
    return (
      <div
        className="rounded-lg border p-4 space-y-2"
        style={{ borderColor: "hsl(var(--muted-foreground) / 0.35)" }}
        data-testid="verdict-unstated"
      >
        <div className="athena-label">Not characterised</div>
        <div className="flex items-baseline gap-3">
          <span className="athena-figure text-2xl" data-testid="text-label">
            {result.label}
          </span>
          <span
            className="athena-mono text-sm text-muted-foreground"
            data-testid="text-confidence"
          >
            {result.confidence === null
              ? "confidence not reported"
              : pct(result.confidence)}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          The engine returned this label without saying whether the model
          actually separated it from the alternatives. So this is not presented
          as a classification, and it is not presented as a tie either — both
          would be claims the engine did not make.
          {floor !== null && (
            <>
              {" "}
              Its no-information floor is {pct(floor)}; a score at the floor
              means the model had no signal.
            </>
          )}
        </p>
      </div>
    );
  }

  if (!result.informative) {
    return (
      <div
        className="rounded-lg border p-4 space-y-2"
        style={{ borderColor: "hsl(var(--gold) / 0.45)" }}
        data-testid="verdict-uninformative"
      >
        <div className="athena-label athena-gold">No classification</div>
        <p className="text-sm text-muted-foreground">
          The model scored every one of its classes equally
          {floor !== null && <> — {pct(floor)} each, the no-information floor</>}
          , so it has expressed no preference. It returned{" "}
          <span className="athena-mono">{result.label}</span> because something
          has to win a tie, not because it recognised anything.
        </p>
        <p className="text-xs text-muted-foreground">
          It can only recognise{" "}
          {result.classes.map((one, index) => (
            <span key={one}>
              {index > 0 && ", "}
              <span className="athena-mono">{one}</span>
            </span>
          ))}
          . Anything else lands here.
        </p>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border p-4 space-y-2"
      style={{ borderColor: "hsl(var(--primary) / 0.4)" }}
      data-testid="verdict-classified"
    >
      <div className="flex items-baseline gap-3">
        <span className="athena-figure text-2xl" data-testid="text-label">
          {result.label}
        </span>
        <span className="athena-mono text-sm text-muted-foreground" data-testid="text-confidence">
          {result.confidence === null ? "confidence not reported" : pct(result.confidence)}
        </span>
      </div>
      {floor !== null && result.confidence !== null && (
        <p className="text-xs text-muted-foreground">
          Against a {pct(floor)} floor — what every class scores when the model
          has no signal. This model separates weakly; the number is the model's,
          not a presentation of it.
        </p>
      )}
      {result.confidence === null && (
        <p className="text-xs text-muted-foreground" data-testid="text-no-confidence">
          The engine returned this label without a confidence figure, so there is
          nothing to read it against. The label is shown because the engine sent
          it; how strongly it was held is not known — and an unsent number is
          not a zero.
        </p>
      )}
      {result.engineVersion && (
        <p className="athena-mono text-xs text-muted-foreground">
          {result.engineVersion}
        </p>
      )}
    </div>
  );
}

export default function CVEClassifier() {
  const [text, setText] = useState("");

  const classify = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/classify-cve", { text });
      return (await response.json()) as Classification;
    },
  });
  const {
    data: classifiers = [],
    isLoading,
    isError: classifiersFailed,
    error: classifiersError,
  } = useQuery<Classifier[]>({
    queryKey: ["/api/classifiers"],
  });

  const active = useMemo(
    () => classifiers.filter((one) => one.status === "active"),
    [classifiers],
  );

  // Weighted by the size of each training set, because an average over models
  // trained on 200 samples and 200,000 samples is not a number about anything.
  const weighted = useMemo(() => {
    const total = active.reduce((sum, one) => sum + one.trainingDataSize, 0);
    if (total === 0) return null;
    const sum = active.reduce(
      (acc, one) => acc + one.accuracy * one.trainingDataSize, 0,
    );
    return sum / total;
  }, [active]);

  return (
    <div className="min-h-screen">
      <div className="container mx-auto p-6 space-y-6 max-w-5xl">
        <PageHeader
          title="Classifiers"
          icon={<Boxes className="w-8 h-8 text-primary" />}
          description="Every model this deployment has loaded, with the accuracy somebody measured and the set they measured it on."
        />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <GlassCard>
            <div className="athena-label">Active models</div>
            <div className="athena-figure text-4xl mt-1" data-testid="text-active-count">
              {classifiersFailed ? "—" : isLoading ? "…" : active.length}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {classifiersFailed ? "Could not load classifiers" : `of ${classifiers.length} recorded`}
            </p>
          </GlassCard>

          <GlassCard className="md:col-span-2">
            <div className="athena-label">Accuracy, weighted by training set</div>
            {classifiersFailed ? (
              <p className="text-sm text-muted-foreground mt-2">
                Could not load classifiers, so there is no figure to give.
              </p>
            ) : weighted === null ? (
              <p className="text-sm text-muted-foreground mt-2">
                No active model has a training set recorded, so there is nothing
                to weight and no figure to give.
              </p>
            ) : (
              <>
                <div
                  className="athena-figure text-4xl mt-1"
                  style={{ color: accuracyColour(weighted) }}
                  data-testid="text-weighted-accuracy"
                >
                  {weighted.toFixed(1)}%
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  A plain average over models trained on very different amounts
                  of data is not a number about anything, so this is weighted by
                  the size of each set.
                </p>
              </>
            )}
          </GlassCard>
        </div>

        {classifiersFailed && (
          // A failed read is not an empty registry.
          <GlassCard ruling>
            <div className="flex gap-3 items-start">
              <CircleSlash className="w-5 h-5 mt-0.5 athena-gold shrink-0" />
              <p className="text-sm text-muted-foreground">
                Could not load classifiers: {errorMessage(classifiersError)}
              </p>
            </div>
          </GlassCard>
        )}

        {!isLoading && !classifiersFailed && classifiers.length === 0 && (
          <GlassCard ruling>
            <div className="flex gap-3 items-start">
              <CircleSlash className="w-5 h-5 mt-0.5 athena-gold shrink-0" />
              <div className="space-y-1">
                <div className="athena-label">No classifiers recorded</div>
                <p className="text-sm text-muted-foreground">
                  Nothing has been registered yet. This page shows what is
                  loaded rather than what could be, so it stays empty until
                  something is.
                </p>
              </div>
            </div>
          </GlassCard>
        )}

        {classifiers.length > 0 && (
          <div className="space-y-3" data-testid="list-classifiers">
            {classifiers.map((one) => (
              <GlassCard key={one.id}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{one.name}</span>
                      <span className="athena-mono text-xs text-muted-foreground">
                        {one.type}
                      </span>
                      {one.status !== "active" && (
                        <span className="athena-label" style={{ color: "hsl(var(--sev-info))" }}>
                          {one.status}
                        </span>
                      )}
                    </div>
                    {one.description && (
                      <p className="text-sm text-muted-foreground">
                        {one.description}
                      </p>
                    )}
                  </div>

                  <div className="flex items-baseline gap-6 shrink-0">
                    <div>
                      <div className="athena-label">Accuracy</div>
                      <div
                        className="athena-figure text-2xl"
                        style={{ color: accuracyColour(one.accuracy) }}
                        data-testid={`text-accuracy-${one.id}`}
                      >
                        {one.accuracy}%
                      </div>
                    </div>
                    <div>
                      <div className="athena-label">Trained on</div>
                      <div className="athena-figure text-2xl">
                        {one.trainingDataSize.toLocaleString()}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 mt-3 text-xs text-muted-foreground">
                  <FlaskConical className="w-3.5 h-3.5 shrink-0" />
                  {one.lastTrainedAt ? (
                    <span>
                      last trained{" "}
                      {formatDistanceToNow(new Date(one.lastTrainedAt), {
                        addSuffix: true,
                      })}
                    </span>
                  ) : (
                    // Not "never trained": nobody wrote down when, which is a
                    // different thing and the only one this row can support.
                    <span>no training date recorded</span>
                  )}
                </div>
              </GlassCard>
            ))}
          </div>
        )}

        <GlassCard className="athena-fluted">
          <div className="athena-label mb-3 flex items-center gap-2">
            <ScanSearch className="w-3.5 h-3.5" />
            Classify a description
          </div>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (text.trim()) classify.mutate();
            }}
          >
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={4}
              placeholder="Paste a vulnerability description or advisory text."
              data-testid="input-cve-text"
            />
            <div className="flex items-center gap-3">
              <Button
                type="submit"
                disabled={!text.trim() || classify.isPending}
                data-testid="button-classify"
              >
                {classify.isPending ? "Asking the engine…" : "Classify"}
              </Button>
              <span className="text-xs text-muted-foreground">
                The engine's model answers. This app does not score anything.
              </span>
            </div>
          </form>

          {classify.isError && (
            <div className="mt-4 text-sm text-destructive" data-testid="text-classify-error">
              {(classify.error as Error).message}
            </div>
          )}

          {classify.data && (
            <div className="mt-4">
              <Verdict result={classify.data} />
            </div>
          )}
        </GlassCard>
      </div>
    </div>
  );
}
