import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { KeyRound, Pencil, Plus, Trash2, UserCheck, UserCog, UserX, X } from "lucide-react";
import { AvatarName } from "@/components/AvatarName";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { authHeaders, useUser, type Permission } from "@/lib/authContext";

type AccessRole = "agent" | "manager" | "admin";
type Team = "retention" | "nsf" | "cs" | "killers";
type TeamAgent = { id: number; name: string; team: Team; active: boolean };
type PortalUser = {
  id: number; username: string; role: "admin" | "edit" | "view"; permissions: Permission[]; active: boolean;
  accessRole?: AccessRole | null; teamAgentId?: number | null; primaryTeam?: Team | null;
  teamGrants?: Team[]; tabGrants?: string[];
  canonicalAgent?: { id: number; name: string | null; team: Team | null; active: boolean | null } | null;
};
type UserForm = {
  username: string; password: string; accessRole: AccessRole | ""; teamAgentId: string;
  primaryTeam: Team | ""; teamGrants: Team[]; tabGrants: string[]; permissions: Permission[];
};

const PERMISSIONS: { value: Permission; label: string; description: string }[] = [
  { value: "view_metrics", label: "View Metrics", description: "Required for canonical Agent and Manager accounts" },
  { value: "view_attendance", label: "View Attendance", description: "See attendance and breaks within data scope" },
  { value: "edit_attendance", label: "Edit Attendance", description: "Update attendance within data scope" },
  { value: "manage_members", label: "Manage Members", description: "Maintain attendance members within data scope" },
  { value: "view_missed_tables", label: "View Missed Tables", description: "Requires full-team access for team-wide rows" },
];
const ALL_PERMISSION_VALUES = PERMISSIONS.map(({ value }) => value);
const TEAMS: { value: Team; label: string }[] = [
  { value: "retention", label: "Retention" }, { value: "nsf", label: "NSF" },
  { value: "cs", label: "Internal CS" }, { value: "killers", label: "Ready-Mode Killers" },
];
const TABS = [
  ["backend-stats", "Backend Statistics"], ["retention", "Retention"], ["cs", "Internal CS"],
  ["nsf", "NSF"], ["rmk", "Ready-Mode Killers"], ["missed-no-cb", "Missed / No Callback"],
  ["callback-review", "Callback Review"], ["violations", "Violations"], ["qa", "Retention QA"],
  ["onboarding", "Onboarding"],
].map(([value, label]) => ({ value: value!, label: label! }));
const EMPTY_FORM: UserForm = {
  username: "", password: "", accessRole: "agent", teamAgentId: "", primaryTeam: "",
  teamGrants: [], tabGrants: [], permissions: ["view_metrics"],
};

function teamLabel(team: Team | null | undefined) {
  return TEAMS.find(({ value }) => value === team)?.label ?? team ?? "";
}
function roleLabel(role: AccessRole | null | undefined) {
  return role ? role[0]!.toUpperCase() + role.slice(1) : "Legacy / Unlinked";
}

function ToggleGrid<T extends string>({ values, onChange, options, disabledValues = [] }: {
  values: T[]; onChange: (values: T[]) => void;
  options: { value: T; label: string; description?: string }[]; disabledValues?: T[];
}) {
  return <div className="mt-2 grid gap-2 sm:grid-cols-2">{options.map((option) => {
    const checked = values.includes(option.value);
    const disabled = disabledValues.includes(option.value);
    return <label key={option.value} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${checked ? "border-border bg-muted/50 text-white" : "border-white/5 bg-zinc-900/60 text-zinc-400"} ${disabled ? "opacity-70" : "cursor-pointer"}`}>
      <input type="checkbox" checked={checked} disabled={disabled}
        onChange={() => onChange(checked ? values.filter((value) => value !== option.value) : [...values, option.value])}
        className="mt-0.5 h-4 w-4 accent-blue-500" />
      <span><span className="font-medium">{option.label}</span>{option.description && <span className="mt-0.5 block text-[10px] text-zinc-500">{option.description}</span>}</span>
    </label>;
  })}</div>;
}

export function CanonicalUserManagementPanel({ onClose }: { onClose: () => void }) {
  const { token } = useUser();
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [agents, setAgents] = useState<TeamAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [newForm, setNewForm] = useState<UserForm>({ ...EMPTY_FORM });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<UserForm>({ ...EMPTY_FORM });
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [userResponse, agentResponse] = await Promise.all([
        apiFetch("/api/users", { headers: { Authorization: `Bearer ${token}` } }),
        apiFetch("/api/team-agents", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (!userResponse.ok || !agentResponse.ok) throw new Error("Failed to load canonical access data");
      setUsers(await userResponse.json() as PortalUser[]);
      setAgents(await agentResponse.json() as TeamAgent[]);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Failed to load users"); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const activeAgents = useMemo(() => agents.filter(({ active }) => active), [agents]);
  const linkedElsewhere = useMemo(() => new Set(users.filter((user) => user.id !== editingId && user.teamAgentId).map((user) => user.teamAgentId!)), [editingId, users]);

  function payload(form: UserForm): Record<string, unknown> {
    return {
      accessRole: form.accessRole,
      teamAgentId: form.accessRole === "agent" ? Number(form.teamAgentId) : null,
      primaryTeam: form.accessRole === "manager" ? form.primaryTeam : null,
      teamGrants: form.accessRole === "admin" ? [] : form.teamGrants,
      tabGrants: form.accessRole === "admin" ? [] : form.tabGrants,
      permissions: form.accessRole === "admin" ? ALL_PERMISSION_VALUES : Array.from(new Set<Permission>(["view_metrics", ...form.permissions])),
    };
  }
  async function request(path: string, method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>) {
    const response = await apiFetch(path, { method, headers: authHeaders(token), ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.ok) return true;
    const data = await response.json().catch(() => ({})) as { error?: string };
    setError(data.error ?? "User access update failed");
    return false;
  }
  async function addUser() {
    setSavingKey("new"); setError("");
    if (await request("/api/users", "POST", { username: newForm.username, password: newForm.password, ...payload(newForm) })) {
      setNewForm({ ...EMPTY_FORM }); await load();
    }
    setSavingKey(null);
  }
  function startEdit(user: PortalUser) {
    if (editingId === user.id) { setEditingId(null); return; }
    setEditingId(user.id); setError("");
    setEditForm({ username: user.username, password: "", accessRole: user.accessRole ?? "",
      teamAgentId: user.teamAgentId ? String(user.teamAgentId) : "", primaryTeam: user.primaryTeam ?? "",
      teamGrants: user.teamGrants ?? [], tabGrants: user.tabGrants ?? [], permissions: user.permissions ?? ["view_metrics"] });
  }
  async function saveUser(user: PortalUser) {
    setSavingKey(`edit-${user.id}`); setError("");
    const body: Record<string, unknown> = editForm.accessRole ? { username: editForm.username, ...payload(editForm) } : { username: editForm.username };
    if (editForm.password) body.password = editForm.password;
    if (await request(`/api/users/${user.id}`, "PATCH", body)) { setEditingId(null); await load(); }
    setSavingKey(null);
  }
  async function toggleActive(user: PortalUser) {
    setSavingKey(`active-${user.id}`); setError("");
    if (await request(`/api/users/${user.id}`, "PATCH", { active: !user.active })) await load();
    setSavingKey(null);
  }
  async function deleteUser(user: PortalUser) {
    if (!confirm(`Permanently delete user "${user.username}"? This cannot be undone.`)) return;
    setSavingKey(`delete-${user.id}`); setError("");
    if (await request(`/api/users/${user.id}`, "DELETE")) { setEditingId(null); await load(); }
    setSavingKey(null);
  }

  function roleFields({ form, setForm, allowLegacy = false }: { form: UserForm; setForm: Dispatch<SetStateAction<UserForm>>; allowLegacy?: boolean }) {
    const selectedAgent = agents.find(({ id }) => String(id) === form.teamAgentId);
    const derivedTeams: Team[] = [
      ...(form.accessRole === "agent" && selectedAgent ? [selectedAgent.team] : []),
      ...(form.accessRole === "manager" && form.primaryTeam ? [form.primaryTeam] : []),
    ];
    const includedFullTeams: Team[] = form.accessRole === "manager" && form.primaryTeam
      ? [form.primaryTeam]
      : [];
    const effectiveTeams = Array.from(new Set<Team>([...derivedTeams, ...form.teamGrants]));
    return <div className="space-y-4">
      <label className="block space-y-1.5"><span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Access Role</span>
        <select value={form.accessRole} onChange={(event) => setForm((current) => ({ ...current,
          accessRole: event.target.value as AccessRole | "", teamAgentId: "", primaryTeam: "", teamGrants: [], tabGrants: [],
          permissions: event.target.value === "admin" ? ALL_PERMISSION_VALUES : ["view_metrics"] }))}
          className="h-9 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-ring/50">
          {allowLegacy && <option value="">Legacy / Unlinked Account</option>}
          <option value="agent">Agent</option><option value="manager">Manager</option><option value="admin">Admin</option>
        </select>
      </label>
      {!form.accessRole && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">This account still uses legacy access. Choose a canonical role to migrate it explicitly. Until then, only username, password, and active status can be maintained here.</div>}
      {form.accessRole === "agent" && <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5"><span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Canonical Agent</span>
          <select value={form.teamAgentId} onChange={(event) => setForm((current) => ({ ...current, teamAgentId: event.target.value }))}
            className="h-9 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 text-sm text-white">
            <option value="">Select active roster identity</option>
            {activeAgents.filter(({ id }) => !linkedElsewhere.has(id)).map((agent) => <option key={agent.id} value={agent.id}>{agent.name} — {teamLabel(agent.team)}</option>)}
          </select>
        </label>
        <div className="space-y-1.5"><span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Derived Team</span>
          <div className="flex h-9 items-center rounded-lg border border-white/10 bg-zinc-900/60 px-3 text-sm text-zinc-300">{selectedAgent ? teamLabel(selectedAgent.team) : "Select an Agent"}</div>
        </div>
      </div>}
      {form.accessRole === "agent" && <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-300"><strong>Default access:</strong> Own metrics only.</div>}
      {form.accessRole === "manager" && <label className="block space-y-1.5"><span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Primary Team</span>
        <select value={form.primaryTeam} onChange={(event) => setForm((current) => ({ ...current, primaryTeam: event.target.value as Team }))}
          className="h-9 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 text-sm text-white">
          <option value="">Select primary team</option>{TEAMS.map((team) => <option key={team.value} value={team.value}>{team.label}</option>)}
        </select>
      </label>}
      {form.accessRole === "manager" && <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-300"><strong>Default access:</strong> {form.primaryTeam ? `All agents in ${teamLabel(form.primaryTeam)}.` : "Select a Primary Team."}</div>}
      {form.accessRole && form.accessRole !== "admin" && <>
        <div><p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Extra Team Access</p>
          <p className="mt-1 text-[11px] text-zinc-500">Agents are self-only unless a team is checked. Managers already receive their Primary Team.</p>
          <ToggleGrid values={Array.from(new Set<Team>([...includedFullTeams, ...form.teamGrants]))} disabledValues={includedFullTeams} options={TEAMS}
            onChange={(values) => setForm((current) => ({ ...current, teamGrants: values.filter((team) => !includedFullTeams.includes(team)) }))} />
        </div>
        <div><p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Tab Access</p>
          <p className="mt-1 text-[11px] text-zinc-500">Metric tabs for {effectiveTeams.length ? effectiveTeams.map(teamLabel).join(", ") : "the derived scope"} are automatic. Onboarding exports remain canonical-admin-only until safe row scoping is available.</p>
          <ToggleGrid values={form.tabGrants} options={TABS} onChange={(tabGrants) => setForm((current) => ({ ...current, tabGrants }))} />
        </div>
        <div><p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Permissions</p>
          <ToggleGrid values={form.permissions} disabledValues={["view_metrics"]} options={PERMISSIONS}
            onChange={(permissions) => setForm((current) => ({ ...current, permissions: Array.from(new Set<Permission>(["view_metrics", ...permissions])) }))} />
        </div>
      </>}
      {form.accessRole === "admin" && <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-blue-200"><strong>Default access: Full access.</strong> Administrators have unrestricted team, tab, and permission access. They do not use roster or team links.</div>}
    </div>;
  }

  const newFormComplete = !!newForm.username.trim() && !!newForm.password
    && (newForm.accessRole !== "agent" || !!newForm.teamAgentId)
    && (newForm.accessRole !== "manager" || !!newForm.primaryTeam);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:p-6" onClick={(event) => event.target === event.currentTarget && onClose()}>
    <div className="relative flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl">
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-4 sm:px-6">
        <div><div className="flex items-center gap-2"><UserCog className="h-5 w-5 text-blue-400" /><h2 className="text-lg font-semibold text-white">User Management</h2></div>
          <p className="mt-1 text-xs text-zinc-500">Canonical identity, data scope, tabs, and permissions</p></div>
        <button type="button" onClick={onClose} className="rounded-lg p-2 text-zinc-500 hover:bg-white/5 hover:text-white" aria-label="Close User Management"><X className="h-5 w-5" /></button>
      </div>
      <div className="space-y-7 overflow-y-auto p-4 sm:p-6">
        <section className="space-y-4 rounded-xl border border-white/10 bg-zinc-900/40 p-4">
          <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Create Canonical Account</p>
            <p className="mt-1 text-xs text-zinc-500">New accounts must use Agent, Manager, or Admin. Existing legacy access remains unchanged until explicitly migrated.</p></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5"><span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Username</span>
              <Input value={newForm.username} onChange={(event) => setNewForm((current) => ({ ...current, username: event.target.value }))} autoComplete="off" className="h-9" /></label>
            <label className="space-y-1.5"><span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Temporary Password</span>
              <Input type="password" value={newForm.password} onChange={(event) => setNewForm((current) => ({ ...current, password: event.target.value }))} autoComplete="new-password" className="h-9" /></label>
          </div>
          <p className="text-[11px] text-zinc-500">Use 15 or more characters and no more than 72 UTF-8 bytes. Long passphrases and symbols are allowed.</p>
          {roleFields({ form: newForm, setForm: setNewForm })}
          <Button size="sm" className="w-full" onClick={() => void addUser()} disabled={savingKey === "new" || !newFormComplete}><Plus className="mr-1 h-3.5 w-3.5" />{savingKey === "new" ? "Creating…" : "Create Account"}</Button>
        </section>
        <section className="space-y-3">
          <div className="flex items-center justify-between"><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Portal Accounts ({users.length})</p><span className="text-[11px] text-zinc-500">Inactive accounts are retained</span></div>
          {loading ? <Skeleton className="h-32 w-full" /> : users.map((user) => <div key={user.id} className={`overflow-hidden rounded-xl border ${user.active ? "border-white/10 bg-zinc-900/50" : "border-white/5 bg-zinc-900/25"}`}>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2"><AvatarName name={user.username} size="sm" textClassName="text-sm font-medium text-white" />
                <Badge className={`border px-2 py-0 text-[10px] ${user.accessRole === "admin" ? "border-blue-500/30 bg-blue-500/15 text-blue-300" : user.accessRole ? "border-white/10 bg-white/5 text-zinc-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300"}`}>{roleLabel(user.accessRole)}</Badge>
                {user.canonicalAgent && <span className="text-xs text-zinc-400">{user.canonicalAgent.name} · {teamLabel(user.canonicalAgent.team)}</span>}
                {user.primaryTeam && <span className="text-xs text-zinc-400">Primary: {teamLabel(user.primaryTeam)}</span>}
                {!user.active && <Badge className="border-red-500/30 bg-red-500/15 px-2 py-0 text-[10px] text-red-300">Inactive</Badge>}
                {user.canonicalAgent?.active === false && <Badge className="border-red-500/30 bg-red-500/15 px-2 py-0 text-[10px] text-red-300">Linked Agent Inactive</Badge>}
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => startEdit(user)} className="rounded p-1.5 text-zinc-500 hover:bg-white/5 hover:text-white" title="Edit account"><Pencil className="h-3.5 w-3.5" /></button>
                <button type="button" disabled={savingKey === `active-${user.id}`} onClick={() => void toggleActive(user)} className="rounded p-1.5 text-zinc-500 hover:bg-white/5 hover:text-white" title={user.active ? "Deactivate account" : "Activate account"}>{user.active ? <UserX className="h-3.5 w-3.5" /> : <UserCheck className="h-3.5 w-3.5" />}</button>
                <button type="button" disabled={savingKey === `delete-${user.id}`} onClick={() => void deleteUser(user)} className="rounded p-1.5 text-zinc-500 hover:bg-red-500/10 hover:text-red-400" title="Delete account"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
            {editingId === user.id && <div className="space-y-4 border-t border-white/5 bg-black/10 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5"><span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Username</span><Input value={editForm.username} onChange={(event) => setEditForm((current) => ({ ...current, username: event.target.value }))} className="h-9" /></label>
                <label className="space-y-1.5"><span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Reset Password (optional)</span><Input type="password" value={editForm.password} onChange={(event) => setEditForm((current) => ({ ...current, password: event.target.value }))} autoComplete="new-password" className="h-9" /></label>
              </div>
              <p className="text-[11px] text-zinc-500">Saving a new password immediately revokes every session for this account.</p>
              {roleFields({ form: editForm, setForm: setEditForm, allowLegacy: !user.accessRole })}
              <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                <Button size="sm" onClick={() => void saveUser(user)} disabled={savingKey === `edit-${user.id}` || !editForm.username.trim()}><KeyRound className="mr-1 h-3.5 w-3.5" />{savingKey === `edit-${user.id}` ? "Saving…" : user.accessRole ? "Save Changes" : editForm.accessRole ? "Migrate & Save" : "Save Legacy Account"}</Button></div>
            </div>}
          </div>)}
        </section>
        {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      </div>
    </div>
  </div>;
}
