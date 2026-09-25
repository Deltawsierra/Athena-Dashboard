/**
 * Teams: the people with access, read from `/api/users`. Each member's name,
 * role, email and active state are live; the approval authority is derived
 * from the role. Columns the user table has no source for -- per-person
 * workload, assigned systems -- are left as a dash rather than invented.
 */
import { useQuery, useMutation } from "@tanstack/react-query";
import { errorMessage } from "@/lib/loaded";
import {
  Users,
  UserCheck,
  ShieldHalf,
  UserCog,
  Search,
  SlidersHorizontal,
  Plus,
  MoreHorizontal,
  ChevronRight,
  CheckCircle2,
  KeyRound,
  Copy,
  Trash2,
  X,
} from "lucide-react";
import { Fragment, useState } from "react";
import PageHero from "@/components/mythos/PageHero";
import StatCard from "@/components/mythos/StatCard";
import GlassCard from "@/components/GlassCard";
import { Divider } from "@/components/mythos/Ornament";
import { Avatar, Timeline, StatusPill, type TimelineStep } from "@/components/mythos/atoms";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";

interface ApiUser { id: string; username: string; role: string; email: string | null; isActive: boolean; createdAt: string }
// The remediation state carried on each assurance finding — enough to derive how
// far the review-and-approval process has actually progressed.
interface ApiFinding { remediationState: string }
// An API key as the server returns it: metadata only, never the secret or hash.
interface ApiKey {
  id: string; name: string; prefix: string; createdBy: string | null;
  createdAt: string; lastUsedAt: string | null; revokedAt: string | null;
}

const TABS = ["Team Members", "Groups", "Access & Permissions"];

const ROLE_META: Record<string, { label: string; icon: typeof ShieldHalf; blurb: string; authority: string }> = {
  admin: { label: "Administrators", icon: ShieldHalf, blurb: "Full platform access and final approval authority.", authority: "Approve (Critical)" },
  user: { label: "Members", icon: Users, blurb: "Run scans, review findings, and manage evidence.", authority: "Recommend" },
};
function roleMeta(role: string) {
  return ROLE_META[role] ?? { label: role.charAt(0).toUpperCase() + role.slice(1), icon: UserCog, blurb: "Team member.", authority: "Recommend" };
}

/**
 * The approval workflow, derived from the real remediation state of the
 * assurance findings rather than a fixed script. Each step's state and detail
 * reflect actual counts, so the timeline never claims progress that did not
 * happen. When the assurance control plane cannot be read, the steps degrade to
 * "todo" and say so, rather than showing invented progress.
 */
function approvalWorkflow(
  findings: ApiFinding[],
  isLoading: boolean,
  isError: boolean,
): TimelineStep[] {
  if (isLoading) {
    return [
      { title: "Athena Identifies Finding", detail: "Reading the assurance record…", state: "todo" },
      { title: "Human Review & Remediation", detail: "Reading the assurance record…", state: "todo" },
      { title: "Evidence Approval", detail: "Reading the assurance record…", state: "todo" },
    ];
  }
  if (isError) {
    const detail = "The assurance control plane could not be read.";
    return [
      { title: "Athena Identifies Finding", detail, state: "todo" },
      { title: "Human Review & Remediation", detail, state: "todo" },
      { title: "Evidence Approval", detail, state: "todo" },
    ];
  }
  const total = findings.length;
  const inReview = findings.filter((f) =>
    ["triaged", "in_progress", "in_review"].includes(f.remediationState),
  ).length;
  const untriaged = findings.filter((f) => f.remediationState === "new").length;
  const closed = findings.filter((f) => ["resolved", "wont_fix"].includes(f.remediationState)).length;

  // Step 1 — findings exist to work at all.
  const identify: TimelineStep = {
    title: "Athena Identifies Finding",
    detail: total > 0
      ? `${total} finding${total === 1 ? "" : "s"} identified across deployments.`
      : "No findings identified yet.",
    state: total > 0 ? "done" : "todo",
  };
  // Step 2 — human review and remediation is underway while any finding is in a
  // working state; done once none are left untriaged or in flight.
  const review: TimelineStep = {
    title: "Human Review & Remediation",
    detail: total === 0
      ? "Awaiting the first finding."
      : `${inReview} in progress · ${untriaged} awaiting triage.`,
    state: total === 0 ? "todo" : inReview + untriaged > 0 ? "active" : "done",
  };
  // Step 3 — evidence approval: how many have reached a closed workflow state.
  const approve: TimelineStep = {
    title: "Evidence Approval",
    detail: total === 0
      ? "No findings to approve."
      : `${closed} of ${total} closed (resolved or accepted as won't-fix).`,
    state: total > 0 && closed === total ? "done" : closed > 0 ? "active" : "todo",
  };
  return [identify, review, approve];
}

const memberInput =
  "rounded-lg border border-border/60 bg-surface-1/60 px-3 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40";

/**
 * The real Add-Member form. It creates an account through the same admin-gated
 * `POST /api/users` the server already enforces — the dashboard owns its own
 * user store, so a new member is a new row there. The password is set now; the
 * server hashes it and never echoes it back. Validation mirrors the server
 * (username and an 8+ character password), so the obvious mistakes are caught
 * before the request, and any refusal (a duplicate name) is surfaced as a toast.
 */
function AddMemberForm({
  pending,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  onSubmit: (v: { username: string; password: string; role: string; email: string | null }) => void;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [email, setEmail] = useState("");
  const canSubmit = username.trim().length > 0 && password.length >= 8;
  return (
    <div className="border-b border-border/50 bg-surface-1/30 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={cn(memberInput, "min-w-[10rem] flex-1")}
          value={username}
          placeholder="Username"
          autoComplete="off"
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className={cn(memberInput, "min-w-[10rem] flex-1")}
          type="password"
          value={password}
          placeholder="Temporary password (8+ characters)"
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          className={cn(memberInput, "min-w-[10rem] flex-1")}
          type="email"
          value={email}
          placeholder="Email (optional)"
          autoComplete="off"
          onChange={(e) => setEmail(e.target.value)}
        />
        <select className={memberInput} value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="user">Member</option>
          <option value="admin">Administrator</option>
        </select>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <button
          className="rounded-lg bg-gradient-to-r from-gold-dim to-gold px-3 py-1.5 text-[12px] font-semibold text-background disabled:opacity-50"
          disabled={pending || !canSubmit}
          onClick={() =>
            onSubmit({
              username: username.trim(),
              password,
              role,
              email: email.trim() ? email.trim() : null,
            })
          }
        >
          {pending ? "Adding…" : "Create member"}
        </button>
        <button
          className="text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </button>
        {password.length > 0 && password.length < 8 && (
          <span className="text-[11px] text-sev-medium">Password needs at least 8 characters.</span>
        )}
      </div>
    </div>
  );
}

/** A timestamp in the reader's locale, or an em dash when absent/unparseable. */
function whenLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/**
 * API-key management: this dashboard's own programmatic credentials. Creating a
 * key mints a secret shown exactly once (only its hash is stored); the list
 * shows metadata only; revoking retires a key permanently. All admin-gated on
 * the server. The fresh secret is held in the parent's state and rendered here
 * until dismissed, because it can never be fetched again.
 */
function ApiKeysPanel({
  keys,
  loading,
  failure,
  fresh,
  onCreate,
  creating,
  onRevoke,
  revokingId,
  onDismissFresh,
}: {
  keys: ApiKey[];
  loading: boolean;
  /** Why the keys could not be read, or null when they were. */
  failure: string | null;
  fresh: { name: string; secret: string } | null;
  onCreate: (name: string) => void;
  creating: boolean;
  onRevoke: (id: string) => void;
  revokingId: string | null;
  onDismissFresh: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast({ title: "Copied to clipboard" }),
      () => toast({ title: "Could not copy", variant: "destructive" }),
    );
  };
  const live = keys.filter((k) => !k.revokedAt);
  const revoked = keys.filter((k) => k.revokedAt);
  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-gold" />
        <p className="text-[13px] font-semibold text-foreground">API Keys</p>
        <span className="text-[11px] text-muted-foreground">programmatic access to this dashboard</span>
      </div>

      {fresh && (
        <div className="mb-3 rounded-xl border border-gold-dim/50 bg-gold/5 p-3">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[12px] font-semibold text-foreground">New key “{fresh.name}” — copy it now</p>
            <button className="text-muted-foreground hover:text-foreground" onClick={onDismissFresh} title="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mb-2 text-[11px] text-muted-foreground">
            This secret is shown only once and is stored only as a hash. If you lose it, revoke this key and create another.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border/60 bg-surface-0/60 px-2 py-1.5 font-mono text-[12px] text-foreground">
              {fresh.secret}
            </code>
            <button
              className="flex items-center gap-1 rounded-md border border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground hover:text-primary"
              onClick={() => copy(fresh.secret)}
            >
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          className={cn(memberInput, "min-w-[12rem] flex-1")}
          value={name}
          placeholder="Key name — e.g. CI pipeline, reporting bot"
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-gold-dim to-gold px-3 py-1.5 text-[12px] font-semibold text-background disabled:opacity-50"
          disabled={creating || !name.trim()}
          onClick={() => {
            onCreate(name.trim());
            setName("");
          }}
        >
          <Plus className="h-3.5 w-3.5" /> {creating ? "Creating…" : "Create key"}
        </button>
      </div>

      {failure !== null ? (
        <p className="text-[12px] text-muted-foreground">Could not load API keys: {failure}</p>
      ) : loading ? (
        <p className="text-[12px] text-muted-foreground">Loading keys…</p>
      ) : keys.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No API keys yet. A key grants programmatic access with the role of the admin who created it.
        </p>
      ) : (
        <ul className="space-y-2">
          {[...live, ...revoked].map((k) => (
            <li
              key={k.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/50 bg-surface-1/40 px-3 py-2"
            >
              <span className="text-[13px] font-medium text-foreground">{k.name}</span>
              <code className="font-mono text-[11px] text-muted-foreground">{k.prefix}…</code>
              {k.revokedAt ? (
                <StatusPill tone="neutral">Revoked</StatusPill>
              ) : (
                <StatusPill tone="complete">Active</StatusPill>
              )}
              <span className="text-[11px] text-muted-foreground/70">
                created {whenLabel(k.createdAt)} · last used {whenLabel(k.lastUsedAt)}
              </span>
              {!k.revokedAt && (
                <button
                  className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-sev-high disabled:opacity-50"
                  disabled={revokingId === k.id}
                  onClick={() => onRevoke(k.id)}
                  title="Revoke this key"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Teams() {
  const { toast } = useToast();
  const {
    data: users = [],
    isLoading,
    isError: usersFailed,
    error: usersError,
  } = useQuery<ApiUser[]>({ queryKey: ["/api/users"] });
  // A count over a directory that could not be read is not zero.
  const tally = (n: number) => (usersFailed ? "—" : isLoading ? "…" : n);
  // The approval workflow is derived from live remediation state; the API keys
  // are this dashboard's own programmatic credentials. Both are admin reads (the
  // /admin route is admin-only), so they load with the page.
  const {
    data: findings = [],
    isLoading: findingsLoading,
    isError: findingsError,
  } = useQuery<ApiFinding[]>({ queryKey: ["/api/assurance/findings"] });
  const {
    data: apiKeys = [],
    isLoading: keysLoading,
    isError: keysFailed,
    error: keysError,
  } = useQuery<ApiKey[]>({
    queryKey: ["/api/api-keys"],
  });

  const [tab, setTab] = useState(TABS[0]);
  const [search, setSearch] = useState("");
  const [roleF, setRoleF] = useState("all");
  const [addingMember, setAddingMember] = useState(false);
  // The one-time plaintext of a freshly minted key, shown until dismissed. It is
  // never re-fetchable, so it is held only in this component's state.
  const [freshKey, setFreshKey] = useState<{ name: string; secret: string } | null>(null);

  const workflow = approvalWorkflow(findings, findingsLoading, findingsError);

  const createMember = useMutation({
    mutationFn: async (input: { username: string; password: string; role: string; email: string | null }) =>
      (await apiRequest("POST", "/api/users", input)).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setAddingMember(false);
      toast({ title: "Member added" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not add member", description: error.message, variant: "destructive" }),
  });

  const createApiKey = useMutation({
    mutationFn: async (name: string) =>
      (await apiRequest("POST", "/api/api-keys", { name })).json() as Promise<{ key: ApiKey; secret: string }>,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/api-keys"] });
      setFreshKey({ name: data.key.name, secret: data.secret });
      toast({ title: "API key created", description: "Copy it now — it is shown only once." });
    },
    onError: (error: Error) =>
      toast({ title: "Could not create key", description: error.message, variant: "destructive" }),
  });

  const revokeApiKey = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/api-keys/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/api-keys"] });
      toast({ title: "API key revoked" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not revoke key", description: error.message, variant: "destructive" }),
  });

  const active = users.filter((u) => u.isActive).length;
  const admins = users.filter((u) => u.role === "admin").length;

  // group by role, in a stable order
  const order = ["admin", "user"];
  const roles = Array.from(new Set(users.map((u) => u.role))).sort(
    (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99),
  );

  // apply the search + role filter, then group what survives
  const q = search.trim().toLowerCase();
  const filtered = users.filter((u) =>
    (roleF === "all" || u.role === roleF) &&
    (q === "" || u.username.toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q)),
  );
  const filtersActive = roleF !== "all" || q !== "";
  const groups = roles
    .map((role) => ({ role, meta: roleMeta(role), members: filtered.filter((u) => u.role === role) }))
    .filter((g) => g.members.length > 0 || !filtersActive);

  const roleMatrix = roles.map((role) => ({ role: roleMeta(role).label, count: users.filter((u) => u.role === role).length }));

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-8">
      <PageHero
        title="Teams"
        subtitle="People power a safer tomorrow. Assign, review, and approve with clarity."
        background="council"
        verbs={["People", "Ownership", "Collaboration", "Trust"]}
      />
      <Divider variant="laurel" className="mt-5" />

      {/* stats -- live from the user directory */}
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total Members" value={tally(users.length)} icon={Users}
          sublabel={usersFailed ? "Could not load team members" : `Across ${roles.length} role${roles.length === 1 ? "" : "s"}`} />
        <StatCard label="Active Members" value={tally(active)} icon={UserCheck} sublabel="Can sign in and act" />
        <StatCard label="Administrators" value={tally(admins)} icon={ShieldHalf} sublabel="Full approval authority" />
        <StatCard label="Inactive" value={tally(users.length - active)} icon={UserCog} sublabel="Access suspended" />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <GlassCard hover={false} bodyClassName="p-0">
            <div className="flex flex-wrap items-center gap-3 border-b border-border/50 px-4 py-3">
              <div className="flex gap-1">
                {TABS.map((t) => (
                  <button key={t} onClick={() => setTab(t)} className={cn("border-b-2 px-2 py-1 text-[13px] font-medium transition-colors", tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{t}</button>
                ))}
              </div>
              {tab === "Team Members" && (
                <div className="ml-auto flex items-center gap-2">
                  <label className="hidden items-center gap-2 rounded-lg border border-border/60 bg-surface-1/50 px-3 py-1.5 text-[12px] text-muted-foreground md:flex">
                    <Search className="h-3.5 w-3.5" />
                    <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search team members…" className="w-40 bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none" />
                  </label>
                  <span className="relative inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-[12px] text-muted-foreground">
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    <select value={roleF} onChange={(e) => setRoleF(e.target.value)} className="cursor-pointer appearance-none bg-transparent pr-1 text-foreground focus:outline-none">
                      <option value="all">All roles</option>
                      {roles.map((r) => <option key={r} value={r}>{roleMeta(r).label}</option>)}
                    </select>
                  </span>
                  <button onClick={() => setAddingMember(true)} className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-gold-dim to-gold px-3 py-1.5 text-[12px] font-semibold text-background"><Plus className="h-3.5 w-3.5" /> Add Member</button>
                </div>
              )}
            </div>
            {tab === "Team Members" && addingMember && (
              <AddMemberForm
                pending={createMember.isPending}
                onSubmit={(v) => createMember.mutate(v)}
                onCancel={() => setAddingMember(false)}
              />
            )}
            {usersFailed ? (
              <p className="px-5 py-10 text-center text-[13px] text-muted-foreground">Could not load team members: {errorMessage(usersError)}</p>
            ) : users.length === 0 ? (
              <p className="px-5 py-10 text-center text-[13px] text-muted-foreground">{isLoading ? "Loading team…" : "No team members found."}</p>
            ) : tab === "Team Members" ? (
              filtered.length === 0 ? (
                <p className="px-5 py-10 text-center text-[13px] text-muted-foreground">No members match the current filter.</p>
              ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/80">
                      {["Name", "Email", "Role", "Approval Authority", "Status", ""].map((h, i) => (
                        <th key={i} className="px-4 py-2 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => {
                      const Icon = g.meta.icon;
                      return (
                        <Fragment key={g.role}>
                          <tr className="border-t border-border/40 bg-surface-1/30">
                            <td colSpan={6} className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                <Icon className="h-4 w-4 text-gold" />
                                <span className="text-[13px] font-semibold text-foreground">{g.meta.label}</span>
                                <span className="text-[11px] text-muted-foreground">({g.members.length})</span>
                                <span className="ml-2 text-[11px] text-muted-foreground/70">{g.meta.blurb}</span>
                              </div>
                            </td>
                          </tr>
                          {g.members.map((m) => (
                            <tr key={m.id} className="border-t border-border/30 hover:bg-surface-1/40">
                              <td className="px-4 py-3"><Avatar name={m.username} size={30} /></td>
                              <td className="px-4 py-3 text-[12px] text-muted-foreground">{m.email ?? "—"}</td>
                              <td className="px-4 py-3 text-[12px] text-foreground">{m.role}</td>
                              <td className="px-4 py-3 text-[12px] text-foreground">{g.meta.authority}</td>
                              <td className="px-4 py-3">
                                {m.isActive
                                  ? <StatusPill tone="complete">Active</StatusPill>
                                  : <StatusPill tone="neutral">Inactive</StatusPill>}
                              </td>
                              <td className="px-4 py-3 text-muted-foreground"><MoreHorizontal className="h-4 w-4" /></td>
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              )
            ) : tab === "Groups" ? (
              <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
                {roles.map((role) => {
                  const meta = roleMeta(role);
                  const Icon = meta.icon;
                  const members = users.filter((u) => u.role === role);
                  return (
                    <div key={role} className="rounded-xl border border-border/50 bg-surface-1/40 p-4">
                      <div className="flex items-center gap-2">
                        <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-gold-dim/40 bg-gold/5 text-gold"><Icon className="h-4 w-4" /></span>
                        <div>
                          <p className="text-[13px] font-semibold text-foreground">{meta.label}</p>
                          <p className="text-[11px] text-muted-foreground">{members.length} member{members.length === 1 ? "" : "s"} · {meta.authority}</p>
                        </div>
                      </div>
                      <p className="mt-2.5 text-[11px] text-muted-foreground/80">{meta.blurb}</p>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {members.slice(0, 8).map((m) => <span key={m.id} title={m.username}><Avatar name={m.username} size={26} /></span>)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/80">
                      {["Role", "Members", "Approval Authority", "Scope"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {roles.map((role) => {
                      const meta = roleMeta(role);
                      return (
                        <tr key={role} className="border-t border-border/40 hover:bg-surface-1/40">
                          <td className="px-4 py-3 text-[13px] font-medium text-foreground">{meta.label}</td>
                          <td className="px-4 py-3 text-[12px] text-muted-foreground">{users.filter((u) => u.role === role).length}</td>
                          <td className="px-4 py-3 text-[12px] text-foreground">{meta.authority}</td>
                          <td className="px-4 py-3 text-[12px] text-muted-foreground">{meta.blurb}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="border-t border-border/50">
                  <ApiKeysPanel
                    keys={apiKeys}
                    loading={keysLoading}
                    failure={keysFailed ? errorMessage(keysError) : null}
                    fresh={freshKey}
                    onCreate={(n) => createApiKey.mutate(n)}
                    creating={createApiKey.isPending}
                    onRevoke={(id) => revokeApiKey.mutate(id)}
                    revokingId={revokeApiKey.isPending ? revokeApiKey.variables ?? null : null}
                    onDismissFresh={() => setFreshKey(null)}
                  />
                </div>
              </div>
            )}
          </GlassCard>
        </div>

        {/* right rail */}
        <div className="space-y-5">
          <GlassCard hover={false} ruling>
            <div className="mb-4 flex items-center justify-between">
              <p className="athena-label">Approval Workflow</p>
              <span className="flex items-center gap-1 text-[11px] text-gold">View workflow <ChevronRight className="h-3 w-3" /></span>
            </div>
            <Timeline steps={workflow} />
            <p className="mt-4 border-t border-border/40 pt-3 text-center text-[10px] uppercase tracking-[0.2em] text-gold-dim">Human judgment turns insight into impact.</p>
          </GlassCard>

          <GlassCard hover={false}>
            <div className="mb-3 flex items-center justify-between">
              <p className="athena-label">Role &amp; Access Matrix</p>
              <ChevronRight className="h-3.5 w-3.5 text-gold" />
            </div>
            <ul className="space-y-2.5">
              {roleMatrix.length === 0 ? (
                <li className="text-[12px] text-muted-foreground">{isLoading ? "Loading…" : "No roles defined."}</li>
              ) : roleMatrix.map((r) => (
                <li key={r.role} className="flex items-center gap-2.5">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                  <span className="min-w-0 flex-1 text-[12px] text-foreground">{r.role}</span>
                  <span className="text-[12px] text-muted-foreground">{r.count} member{r.count === 1 ? "" : "s"}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t border-border/40 pt-2 text-[11px] text-muted-foreground/70">
              {active === users.length ? "All members are active." : `${users.length - active} member(s) suspended.`}
            </p>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
