/**
 * Declaring the next revision of an incident's scope, from the recovery screen (SPINE
 * SP-3; DASH-DECLARE): what is believed affected, said by an administrator.
 *
 * Drawn on an incident's card only for an administrator of this console (as
 * NotKnownPanel draws its write: the console's own role, read from /api/auth/check),
 * and only where Athena-Backend reports the incident's scope. Athena-Backend decides:
 * the revision is posted there as the signed-in person, admin-only there too, and its
 * 403 is said in words like every other refusal.
 *
 * The form is built from what the backend serves, never from what is typed:
 *
 *   - the items are picked from the deployment's own assets (by uuid) and approved
 *     workflows (by slug), the two kinds a revision takes. The form starts from the
 *     current revision's items that are offered; one of the current items that is not
 *     offered is named as one this revision removes. No text field takes an item;
 *   - the reason is one line, checked as the backend checks it before anything is sent;
 *   - the evidence is picked from the incident's own.
 *
 * Before posting, a review says in words what the revision adds and removes against
 * the current one. One that changes nothing is not posted. Nothing is offered for
 * posting while a list could not be read whole, since the revision could then drop an
 * item nobody chose.
 *
 * A refusal is said from its code alone, never with the backend's words or anything
 * typed, and nothing else on the screen changes. After a recording -- and after an
 * answer that leaves it unknown whether one was made -- this incident's scope, its
 * recovery record and the choices are read again from the backend: nothing is drawn
 * from the write's answer.
 *
 * OFF THE STOP PATH. Nothing is read for the form until it is opened; one incident's
 * form is open at a time (OneDeclarationAtATime), and closing it or leaving the screen
 * cancels its read (lib/queryClient.ts); one declaration is in flight in the whole
 * console at a time; and there is no modal over the page. So the form keeps at most one
 * of the browser's connections for its read and one for its post, whatever the backend
 * does with them, and never stands in front of a Stop. Every string from the backend is
 * drawn as text by the app's own runtime, which marks any character that hides or
 * reorders text (lib/hiddenChars.ts).
 */
import { createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import type { ScopeItemRef } from "@shared/incident-scope";
import type { RecoveryIncident } from "@shared/recovery-record";
import type { PublicUser } from "@shared/schema";
import {
  REASON_MOST, REFUSAL_CODE, declarable, itemKey, reasonLength, reasonProblem, scopeChange,
  type DeclareScopeBody, type DeclaredItem, type ReasonProblem, type ScopeChoices,
} from "@shared/scope-declaration";
import { ApiError, UnauthorizedError, apiRequest } from "@/lib/queryClient";
import { isAdmin } from "@/utils/auth";
import { Absent, Fact, NotInHand, UnreadableRows, served, unreadableIn } from "./parts";
import { OnDemand, answeredFor } from "./history";
import { kindInWords } from "./IncidentScope";

/** A finding id as this screen will put it in a path (Authority.tsx holds ?finding= to the same rule). */
const FINDING_ID = /^[0-9A-Za-z][0-9A-Za-z_-]*$/;

/** Every declaration in flight, in the whole console, under this key: one at a time. */
export const DECLARE_SCOPE = ["declare-scope"] as const;

// ---- one form open at a time ----

const OpenDeclaration = createContext<{ open: string | null; set: Dispatch<SetStateAction<string | null>> } | null>(null);

/**
 * Holds which incident's declaration form is open: one at a time. Opening another
 * closes the first, and a closed form's read is cancelled, so the forms of one screen
 * never keep more than one of the browser's connections for their reads.
 */
export function OneDeclarationAtATime({ children }: { children: ReactNode }) {
  const [open, set] = useState<string | null>(null);
  return <OpenDeclaration.Provider value={{ open, set }}>{children}</OpenDeclaration.Provider>;
}

function useDeclarationOpen(key: string): [boolean, (open: boolean) => void] {
  const shared = useContext(OpenDeclaration);
  const [own, setOwn] = useState(false);
  if (shared === null) return [own, setOwn];
  // Closing closes this form only: another incident's, opened since, stays open.
  return [shared.open === key, (open) => shared.set((now) => (open ? key : now === key ? null : now))];
}

// ---- the words ----

/** Each backend refusal code, in words. Each says what the backend refused and that nothing was recorded. */
const REFUSED: Record<string, string> = {
  malformed:
    "Athena-Backend refused this revision as malformed: one of its parts is not in the form a scope revision takes, or is missing. Nothing was recorded.",
  not_posted: "Athena-Backend refused this revision: it carried a part a scope revision does not take. Nothing was recorded.",
  items_required: "Athena-Backend refused this revision: it names no item in scope, or its items were left out. Nothing was recorded.",
  reason_required: "Athena-Backend refused this revision: its reason is blank, or was left out. Nothing was recorded.",
  evidence_required: "Athena-Backend refused this revision: it names no evidence, or its evidence was left out. Nothing was recorded.",
  unknown_link:
    "Athena-Backend refused this revision: an item or a piece of evidence it names is not this deployment's own, or no longer exists. Nothing was recorded. Close this form and open it again to read the choices again.",
  nothing_changed:
    "Athena-Backend refused this revision: it names exactly the items of the current revision, so it changes nothing. Nothing was recorded.",
  not_current:
    "Athena-Backend refused this revision: another revision became current before this one arrived. Nothing was recorded. Close this form and open it again to declare from the current scope.",
  raced:
    "Athena-Backend refused this revision: another revision of this scope was declared at the same moment. Nothing was recorded. Close this form and open it again to declare from the current scope.",
  bad_supersedes: "Athena-Backend refused this revision: its number does not follow the current revision's. Nothing was recorded.",
  declared_by_required:
    "Athena-Backend refused this revision: a revision that removes an item names who declared it, and it did not take this one as yours. Nothing was recorded.",
};

/** What became of a declaration, as the card says it. */
interface Said {
  /** recorded; refused (nothing recorded); not_sent; unknown (it may have been recorded). */
  tone: "recorded" | "refused" | "not_sent" | "unknown";
  text: string;
  /** The code this was said from, when there was one. */
  code: string | null;
}

const RECORDED =
  "Athena-Backend recorded the revision. This incident's scope and its recovery record are being read again from it, so what is drawn here is what it serves now.";
const READ_AGAIN =
  "This incident's scope and its recovery record are being read again from Athena-Backend: look at them before declaring this again.";

/**
 * A failed declaration in words, from this console's answer: its status, the backend's
 * code and the backend's status. Never from a message carried in the answer, so nothing
 * the backend said and nothing typed is repeated.
 */
export function saidOf(error: unknown): Said {
  if (error instanceof UnauthorizedError) {
    return { tone: "not_sent", code: null, text: "Not sent: your session with this console has ended. Sign in again, then declare it again." };
  }
  if (!(error instanceof ApiError)) {
    return {
      tone: "unknown", code: null,
      text: `Whether Athena-Backend recorded this revision is not known: this console did not answer the declaration. ${READ_AGAIN}`,
    };
  }
  const body = error.body ?? {};
  const code = typeof body.code === "string" && REFUSAL_CODE.test(body.code) ? body.code : null;
  const fromBackend = Object.prototype.hasOwnProperty.call(body, "backendStatus");
  if (error.status === 503 && code === "outcome_unknown") {
    const answered = typeof body.backendStatus === "number" ? `it answered ${body.backendStatus}, which is neither a recording nor a refusal` : "no answer came back";
    return { tone: "unknown", code, text: `Whether Athena-Backend recorded this revision is not known: ${answered}. ${READ_AGAIN}` };
  }
  if (error.status === 503 && code === "backend_sign_in_required") {
    return {
      tone: "not_sent", code,
      text: "Not recorded: Athena-Backend does not take your sign-in, or it has ended. Sign in to Athena-Backend again, then declare it again.",
    };
  }
  if (error.status === 503) {
    return { tone: "not_sent", code, text: "Not sent: this console could not reach Athena-Backend to declare it." };
  }
  if (fromBackend && [400, 403, 404, 409].includes(error.status)) {
    if (code !== null && Object.prototype.hasOwnProperty.call(REFUSED, code)) return { tone: "refused", code, text: REFUSED[code] };
    if (code !== null) {
      return { tone: "refused", code, text: `Athena-Backend refused this revision (it answered ${error.status}) with a code this console does not know: ${code}.` };
    }
    if (error.status === 403) {
      return {
        tone: "refused", code,
        text: "Athena-Backend refused this revision: declaring a scope takes an administrator's role on Athena-Backend, and it does not give you one (it answered 403). Nothing was recorded.",
      };
    }
    if (error.status === 404) {
      return { tone: "refused", code, text: "Athena-Backend answered that it has no such finding for you (404). Nothing was recorded." };
    }
    return { tone: "refused", code, text: `Athena-Backend refused this revision (it answered ${error.status}) and named no code for why.` };
  }
  if (error.status === 403) {
    return {
      tone: "not_sent", code,
      text: "This console refused to send this revision: declaring a scope takes an administrator's role in this console (it answered 403). Nothing was sent.",
    };
  }
  if (error.status === 400) {
    return { tone: "not_sent", code, text: "This console refused to send this revision: it is not in the form a scope revision takes. Nothing was sent." };
  }
  return {
    tone: "unknown", code,
    text: `Whether Athena-Backend recorded this revision is not known: this console answered ${error.status}. ${READ_AGAIN}`,
  };
}

/** Why a reason would be refused, in words. Never repeats the reason. */
function reasonInWords(problem: ReasonProblem, length: number): string {
  switch (problem) {
    case "blank":
      return "The reason is blank: say why the scope is this, in one line.";
    case "line_break":
      return "The reason holds a line break: Athena-Backend takes one line.";
    case "not_printable":
      return "The reason holds a character that is not printable -- a control, format or separator character such as a tab, a zero-width character, a direction mark or a no-break space. Athena-Backend takes printable characters and the ordinary space only.";
    default:
      return `The reason is ${length} characters long: Athena-Backend takes at most ${REASON_MOST}.`;
  }
}

// ---- small pieces ----

function Heading({ children }: { children: string }) {
  return <p className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>;
}

/** One item a revision may name, as the form offers it: its kind, its name as served, and its reference. */
interface Offered extends DeclaredItem {
  name: string | null;
  /** An asset's own kind, as served. */
  detail: string | null;
}

/** One item, in words: its kind, its name and its reference, each as served. */
function ItemWords({ item }: { item: ScopeItemRef & { name?: string | null; detail?: string | null } }) {
  return (
    <span data-testid="declare-item-words" data-item-kind={item.kind ?? ""}>
      <span className="text-muted-foreground">{kindInWords(item.kind)}</span>
      {item.name ? <> <span className="break-all text-foreground">{item.name}</span></> : null}
      {item.detail ? <span className="break-all text-muted-foreground"> ({item.detail})</span> : null}{" "}
      <code className="break-all font-mono text-[11px] text-foreground/90">{item.ref ?? "no reference served"}</code>
    </span>
  );
}

/** A list of items in words, or what stands for an empty one. */
function ItemsInWords({ items, none, testId }: { items: Array<ScopeItemRef & { name?: string | null; detail?: string | null }>; none: string; testId: string }) {
  if (items.length === 0) return <span data-testid={testId} data-item-count={0}>{none}</span>;
  return (
    <span data-testid={testId} data-item-count={items.length}>
      {items.map((item, index) => (
        <span key={index}>
          {index > 0 ? "; " : ""}
          <ItemWords item={item} />
        </span>
      ))}
    </span>
  );
}

// ---- the form ----

/** The re-read after a declaration: this incident's scope, its recovery record (its page and its own read) and the choices. */
function readAgain(client: QueryClient, deployment: string, finding: string): void {
  const f = encodeURIComponent(finding);
  const keys = new Set([
    `/api/assurance/findings/${f}/scope-revisions`,
    `/api/assurance/findings/${f}/recovery-record`,
    `/api/assurance/findings/${f}/scope-choices`,
    `/api/assurance/deployments/${encodeURIComponent(deployment)}/recovery-records`,
  ]);
  // A read in flight was asked before the declaration: cancelled first, then asked again (as Assurance.tsx does).
  const fed = (query: Query) => typeof query.queryKey[0] === "string" && keys.has(query.queryKey[0]);
  void client.cancelQueries({ predicate: fed });
  void client.invalidateQueries({ predicate: fed });
}

function DeclareForm({ finding, deployment, pending, another, onDeclare }: {
  finding: string;
  deployment: string;
  /** This form's declaration is in flight. */
  pending: boolean;
  /** Another declaration is in flight somewhere in the console. */
  another: boolean;
  onDeclare: (body: DeclareScopeBody) => void;
}) {
  const query = useQuery<ScopeChoices>({ queryKey: [`/api/assurance/findings/${encodeURIComponent(finding)}/scope-choices`] });
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [rests, setRests] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [reviewing, setReviewing] = useState(false);

  if (query.isError && query.error instanceof ApiError && query.error.status === 404) {
    return (
      <p className="text-[12px]" data-testid="declare-scope-not-found">
        <Absent>
          Athena-Backend answers that it has no such finding for you, so nothing can be declared for it here. It answers a
          finding you may not read exactly as one that does not exist.
        </Absent>
      </p>
    );
  }
  const source = served(query);
  if (source.state !== "ready") return <NotInHand source={source} what="what this incident's scope can be declared from" />;
  const choices = source.data;
  const shaped: unknown = choices;
  const held = shaped !== null && typeof shaped === "object" && !Array.isArray(shaped) ? (shaped as Record<string, unknown>) : null;
  const current = held !== null && held.current !== null && typeof held.current === "object" ? (held.current as Record<string, unknown>) : null;
  if (held === null || !Array.isArray(held.assets) || !Array.isArray(held.workflows) || !Array.isArray(held.evidence) || current === null
    || !(current.items === null || Array.isArray(current.items))) {
    return (
      <p className="text-[12px] text-amber-400" data-testid="declare-scope-answer-unreadable">
        The answer to what this incident&apos;s scope can be declared from is not one this console can read, so nothing is
        offered for a revision.
      </p>
    );
  }
  if (!answeredFor(choices.deployment, deployment) || !answeredFor(choices.finding, finding)) {
    return (
      <p className="text-[12px]" data-testid="declare-scope-other-incident">
        <Absent>
          Athena-Backend answered for another deployment or finding ({choices.deployment ?? "no deployment named"},{" "}
          {choices.finding ?? "no finding named"}), so nothing is offered for a revision here.
        </Absent>
      </p>
    );
  }

  // Only what the deployment serves is offered, and only of the kinds a revision takes.
  const offered: Offered[] = [
    ...choices.assets.map((one): Offered => ({ kind: "asset", ref: one.uuid, name: one.name, detail: one.kindLabel ?? one.kind })),
    ...choices.workflows.map((one): Offered => ({ kind: "workflow", ref: one.slug, name: one.name, detail: null })),
  ].filter((one) => declarable(one.kind));
  const offeredKeys = new Set(offered.map(itemKey));
  const currentItems = choices.current.items;
  const currentKnown = currentItems !== null && unreadableIn(choices, "current.items") === 0 && unreadableIn(choices, "revisions") === 0;
  const listsWhole = unreadableIn(choices, "assets") === 0 && unreadableIn(choices, "workflows") === 0 && choices.workflowsWhole === true;
  const start = new Set((currentItems ?? []).map(itemKey).filter((key) => offeredKeys.has(key)));
  const chosen = picked ?? start;
  const next = offered.filter((one) => chosen.has(itemKey(one)));
  const notOffered = (currentItems ?? []).filter((one) => !offeredKeys.has(itemKey(one)));
  const change = scopeChange(currentItems ?? [], next);
  // A removed item is named as the lists name it, where they do; one they do not offer, as the scope recorded it.
  const byKey = new Map(offered.map((one) => [itemKey(one), one] as const));
  const removed = change.removed.map((one) => byKey.get(itemKey(one)) ?? one);
  const revision = choices.current.revision;
  const first = revision === null;
  const number = first ? 1 : revision + 1;
  const evidence = choices.evidence.filter((one) => rests.has(one.uuid));
  const problem = reasonProblem(reason);
  const changesNothing = !first && change.added.length === 0 && change.removed.length === 0;

  const blocked: Array<{ key: string; text: string }> = [];
  if (!listsWhole) {
    blocked.push({
      key: "lists",
      text: "The deployment's assets or approved workflows could not be read whole, so a revision drawn here could drop an item nobody chose. Nothing can be declared until they are read whole.",
    });
  }
  if (!currentKnown) {
    blocked.push({
      key: "current",
      text: "The current revision's items could not be read, so what a new revision would change is not known. Nothing can be declared until they are read.",
    });
  }
  if (next.length === 0) blocked.push({ key: "items", text: "Pick at least one item: a revision names what is in scope." });
  if (evidence.length === 0) blocked.push({ key: "evidence", text: "Pick at least one piece of this incident's evidence: a revision names what it rests on." });
  if (problem !== null) blocked.push({ key: `reason:${problem}`, text: reasonInWords(problem, reasonLength(reason)) });
  if (changesNothing && currentKnown) {
    blocked.push({
      key: "nothing",
      text: `This revision would change nothing against revision ${revision}: it names exactly the same items. Athena-Backend would refuse it, so it is not sent.`,
    });
  }

  const toggle = (key: string) => {
    if (pending) return;
    const now = new Set(chosen);
    if (now.has(key)) now.delete(key);
    else now.add(key);
    setPicked(now);
    setReviewing(false);
  };
  const toggleEvidence = (uuid: string) => {
    if (pending) return;
    const now = new Set(rests);
    if (now.has(uuid)) now.delete(uuid);
    else now.add(uuid);
    setRests(now);
    setReviewing(false);
  };
  const declare = () => {
    // Checked again at the press: nothing is sent while anything above stands in the way.
    if (blocked.length > 0 || pending || another) return;
    onDeclare({ items: next.map((one) => ({ kind: one.kind, ref: one.ref })), reason, evidence: evidence.map((one) => one.uuid) });
  };

  return (
    <div className="space-y-2" data-testid="declare-scope-form" data-revision={number}>
      <p className="text-[12px] text-muted-foreground">
        {first
          ? "No scope is declared for this incident yet: this would be its first revision."
          : `The current scope is revision ${revision}. A new revision names the whole scope: the items picked below.`}
      </p>

      <Heading>Items in scope: the deployment&apos;s own assets and approved workflows</Heading>
      <UnreadableRows from={choices} list="assets" label="the deployment's assets" />
      <UnreadableRows from={choices} list="workflows" label="the deployment's approved workflows" />
      {choices.workflowsWhole === false && (
        <p className="text-[12px] text-amber-400" data-testid="declare-workflows-cut">
          Athena-Backend returned only some of the deployment&apos;s approved workflows.
        </p>
      )}
      {choices.workflowsWhole === null && (
        <p className="text-[12px] text-amber-400" data-testid="declare-workflows-cut">
          Athena-Backend did not say whether it returned every approved workflow.
        </p>
      )}
      {choices.assetsElsewhere > 0 && (
        <p className="text-[12px] text-amber-400" data-testid="declare-assets-elsewhere">
          {`${choices.assetsElsewhere} ${choices.assetsElsewhere === 1 ? "asset was" : "assets were"} answered for another deployment and ${choices.assetsElsewhere === 1 ? "is" : "are"} not offered.`}
        </p>
      )}
      {offered.length === 0 ? (
        <p className="text-[12px]" data-testid="declare-items-none">
          <Absent>Athena-Backend serves no asset and no approved workflow for this deployment, so there is no item to pick.</Absent>
        </p>
      ) : (
        <ul className="space-y-1" data-testid="declare-items" data-item-count={offered.length}>
          {offered.map((one) => {
            const key = itemKey(one);
            return (
              <li key={key} className="text-[12px]">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    data-testid="declare-item"
                    data-item-kind={one.kind}
                    data-item-ref={one.ref}
                    checked={chosen.has(key)}
                    disabled={pending}
                    onChange={() => toggle(key)}
                  />
                  <ItemWords item={one} />
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {notOffered.length > 0 && (
        <p className="text-[12px] text-amber-400" data-testid="declare-not-offered" data-item-count={notOffered.length}>
          In the current scope and not among the deployment&apos;s assets or approved workflows as read now, so not offered:{" "}
          <ItemsInWords items={notOffered} none="" testId="declare-not-offered-items" />. A new revision would not name{" "}
          {notOffered.length === 1 ? "it" : "them"}.
        </p>
      )}

      <Heading>Rests on: this incident&apos;s own evidence</Heading>
      <UnreadableRows from={choices} list="evidence" label="this incident's evidence" />
      {choices.evidence.length === 0 ? (
        <p className="text-[12px]" data-testid="declare-evidence-none">
          <Absent>Athena-Backend serves no evidence of this incident, so there is none to rest a revision on.</Absent>
        </p>
      ) : (
        <ul className="space-y-1" data-testid="declare-evidence" data-evidence-count={choices.evidence.length}>
          {choices.evidence.map((one) => (
            <li key={one.uuid} className="text-[12px]">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  data-testid="declare-evidence-item"
                  data-evidence-ref={one.uuid}
                  checked={rests.has(one.uuid)}
                  disabled={pending}
                  onChange={() => toggleEvidence(one.uuid)}
                />
                <span data-testid="declare-evidence-words">
                  <span className="break-all text-muted-foreground">{one.classificationLabel ?? one.classification ?? "classification not served"}</span>{" "}
                  {one.summary ? <span className="break-all text-foreground">{one.summary}</span> : null}
                  {one.source ? <span className="break-all text-muted-foreground"> ({one.source})</span> : null}{" "}
                  <code className="break-all font-mono text-[11px] text-foreground/90">{one.uuid}</code>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <Heading>Why the scope is this</Heading>
      <label className="block space-y-1 text-[12px]">
        <span className="text-muted-foreground">{`Reason: one line, at most ${REASON_MOST} characters`}</span>
        <input
          type="text"
          data-testid="declare-reason"
          className="w-full rounded-md border border-border/60 bg-surface-1/60 px-2 py-1 text-[12px] text-foreground"
          value={reason}
          disabled={pending}
          onChange={(event) => {
            setReason(event.target.value);
            setReviewing(false);
          }}
        />
        <span className="text-muted-foreground" data-testid="declare-reason-length">{`${reasonLength(reason)} of ${REASON_MOST}`}</span>
      </label>

      {blocked.length > 0 && (
        <ul className="space-y-1" data-testid="declare-scope-blocked" data-blocked={blocked.map((one) => one.key).join(" ")}>
          {blocked.map((one) => (
            <li key={one.key} className="text-[12px] text-amber-400" data-blocked-by={one.key}>
              {one.text}
            </li>
          ))}
        </ul>
      )}

      {!reviewing ? (
        <button
          type="button"
          data-testid="declare-scope-review"
          className="rounded-md bg-primary/15 px-3 py-1 text-[12px] font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
          disabled={blocked.length > 0 || pending}
          onClick={() => setReviewing(true)}
        >
          Review what this revision changes
        </button>
      ) : (
        <div className="space-y-1 rounded-md border border-border/50 p-2" data-testid="declare-scope-change" data-revision={number}>
          <p className="text-[12px] font-medium text-foreground" data-testid="declare-scope-change-heading">
            {first
              ? `Revision ${number} would be this incident's first scope.`
              : `Against revision ${revision}, revision ${number} would:`}
          </p>
          <Fact label="Add">
            <ItemsInWords items={change.added} none="nothing" testId="declare-scope-adds" />
          </Fact>
          <Fact label="Remove">
            <ItemsInWords items={removed} none="nothing" testId="declare-scope-removes" />
          </Fact>
          <Fact label="Rest on">
            <span data-testid="declare-scope-rests-on">{`${evidence.length} ${evidence.length === 1 ? "piece" : "pieces"} of this incident's evidence`}</span>
          </Fact>
          {another && !pending && (
            <p className="text-[12px] text-muted-foreground" data-testid="declare-scope-another">
              Another revision is being declared from this console: this one can be sent once it has an answer.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="declare-scope-send"
              className="rounded-md bg-primary/15 px-3 py-1 text-[12px] font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
              disabled={blocked.length > 0 || pending || another}
              onClick={declare}
            >
              {pending ? `Declaring revision ${number}...` : `Declare revision ${number}`}
            </button>
            <button
              type="button"
              data-testid="declare-scope-change-back"
              className="text-[12px] text-muted-foreground hover:underline disabled:opacity-50"
              disabled={pending}
              onClick={() => setReviewing(false)}
            >
              Change it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The declaration on one incident: the form on demand, its post, and what became of it. */
function Declaration({ finding, deployment }: { finding: string; deployment: string }) {
  const client = useQueryClient();
  const [open, setOpen] = useDeclarationOpen(finding);
  const [said, setSaid] = useState<Said | null>(null);
  const inFlight = useIsMutating({ mutationKey: DECLARE_SCOPE });
  const declaration = useMutation({
    mutationKey: DECLARE_SCOPE,
    mutationFn: async (body: DeclareScopeBody) => {
      const response = await apiRequest("POST", `/api/assurance/findings/${encodeURIComponent(finding)}/declare-scope`, body);
      // Only this console's 201 says it was recorded; any other answer leaves it unknown.
      if (response.status !== 201) throw new ApiError(`answered ${response.status}`, response.status, null);
    },
    onMutate: () => setSaid(null),
    onSuccess: () => {
      readAgain(client, deployment, finding);
      setOpen(false);
      setSaid({ tone: "recorded", code: null, text: RECORDED });
    },
    onError: (error: unknown) => {
      const now = saidOf(error);
      // Refused or not sent: nothing changed, and nothing but the message is drawn anew. Not known: read again.
      if (now.tone === "unknown") readAgain(client, deployment, finding);
      setSaid(now);
    },
  });
  const pending = declaration.isPending;
  return (
    <div className="space-y-1" data-testid="incident-scope-declaration">
      <OnDemand
        label="the form to declare this incident's next scope revision"
        testId="incident-scope-declare"
        open={open || pending}
        onToggle={(now) => { if (!pending) setOpen(now); }}
      >
        {() => (
          <DeclareForm
            finding={finding}
            deployment={deployment}
            pending={pending}
            another={inFlight > 0 && !pending}
            onDeclare={(body) => declaration.mutate(body)}
          />
        )}
      </OnDemand>
      {said !== null && (
        <p
          role="status"
          className={said.tone === "recorded" ? "text-[12px] text-foreground" : "text-[12px] text-amber-400"}
          data-testid="declare-scope-said"
          data-said={said.tone}
          data-code={said.code ?? ""}
        >
          {said.text}
        </p>
      )}
    </div>
  );
}

/**
 * On an incident's card: the declaration of its next scope revision, for an
 * administrator of this console, where Athena-Backend reports the incident's scope.
 * Anyone else, and an incident on a backend that reports no scope, is shown nothing.
 */
export default function DeclareScope({ incident, deployment }: { incident: RecoveryIncident; deployment: string }) {
  const { data: session } = useQuery<{ authenticated: boolean; user: PublicUser | null }>({ queryKey: ["/api/auth/check"] });
  const admin = isAdmin(session?.user ?? null);
  const finding = incident.finding;
  if (!admin || incident.scope === undefined || finding === null || !FINDING_ID.test(finding)) return null;
  return <Declaration finding={finding} deployment={deployment} />;
}
