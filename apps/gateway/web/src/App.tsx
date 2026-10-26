// Switchyard dashboard: one page, plain and functional. All authorization happens on the server;
// the UI only hides admin controls from members for convenience.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api";

interface Me { id: number; email: string; role: "admin" | "member"; publicMcpUrl: string }
interface Tool { name: string; description: string }
interface Server {
  id: number; slug: string; name: string; url: string; authType: string; authHeader: string | null;
  hasCredential: boolean; enabled: boolean; status: "connected" | "unreachable" | "disabled";
  reason: string | null; lastChecked: string | null; tools: Tool[];
}
interface Key { id: number; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }
interface User { id: number; email: string; role: string; keys: Key[] }
interface Audit { id: number; ts: string; user_email: string; source: string; server_slug: string; tool: string; duration_ms: number; outcome: string; error: string | null; args_preview: string }
interface ToolCall { name: string; arguments: unknown; ok: boolean; durationMs: number; result: string }
interface Msg { role: "user" | "assistant"; content: string; toolCalls?: ToolCall[]; error?: string }

const fmt = (t: string | null) => (t ? new Date(t).toLocaleString("en-IN") : "—");

function usePoll<T>(path: string, ms: number): [T | null, () => void, string] {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    api<T>(path).then((d) => { setData(d); setErr(""); }).catch((e) => setErr(e.message));
  }, [path]);
  useEffect(() => {
    load();
    const t = setInterval(load, ms);
    return () => clearInterval(t);
  }, [load, ms]);
  return [data, load, err];
}

function Err({ msg }: { msg: string }) {
  return msg ? <p className="err">{msg}</p> : null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section><h2>{title}</h2>{children}</section>;
}

// ---------- login ----------
function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    api("/auth/login", "POST", { email, password }).then(onLogin).catch((e) => setErr(e.message));
  };
  return (
    <form className="login" onSubmit={submit}>
      <h1>Switchyard</h1>
      <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button>Log in</button>
      <Err msg={err} />
    </form>
  );
}

// ---------- servers ----------
function AddServer({ onDone }: { onDone: () => void }) {
  const empty = { slug: "", name: "", url: "", authType: "none", authHeader: "", credential: "" };
  const [f, setF] = useState(empty);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    api("/servers", "POST", f).then(() => { setF(empty); setErr(""); onDone(); }).catch((e) => setErr(e.message));
  };
  return (
    <form className="row" onSubmit={submit}>
      <input placeholder="slug (e.g. github)" value={f.slug} onChange={set("slug")} size={12} />
      <input placeholder="name" value={f.name} onChange={set("name")} size={14} />
      <input placeholder="https://host/mcp" value={f.url} onChange={set("url")} size={30} />
      <select value={f.authType} onChange={set("authType")}>
        <option value="none">no auth</option>
        <option value="bearer">bearer token</option>
        <option value="header">custom header</option>
      </select>
      {f.authType === "header" && <input placeholder="header name" value={f.authHeader} onChange={set("authHeader")} size={12} />}
      {f.authType !== "none" && <input placeholder="credential" type="password" value={f.credential} onChange={set("credential")} size={16} />}
      <button>Add server</button>
      <Err msg={err} />
    </form>
  );
}

function EditServer({ s, onDone }: { s: Server; onDone: () => void }) {
  const [f, setF] = useState({ name: s.name, url: s.url, authType: s.authType, authHeader: s.authHeader ?? "", credential: "" });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { name: f.name, url: f.url, authType: f.authType, authHeader: f.authHeader };
    if (f.credential) body.credential = f.credential; // blank = keep the stored credential
    api(`/servers/${s.id}`, "PATCH", body).then(onDone).catch((e) => setErr(e.message));
  };
  return (
    <form className="row" onSubmit={submit}>
      <input value={f.name} onChange={set("name")} size={14} />
      <input value={f.url} onChange={set("url")} size={30} />
      <select value={f.authType} onChange={set("authType")}>
        <option value="none">no auth</option>
        <option value="bearer">bearer token</option>
        <option value="header">custom header</option>
      </select>
      {f.authType === "header" && <input placeholder="header name" value={f.authHeader} onChange={set("authHeader")} size={12} />}
      {f.authType !== "none" && (
        <input placeholder={s.hasCredential ? "•••• (blank = keep)" : "credential"} type="password" value={f.credential} onChange={set("credential")} size={16} />
      )}
      <button>Save</button>
      <Err msg={err} />
    </form>
  );
}

function Servers({ me }: { me: Me }) {
  const [servers, reload, err] = usePoll<Server[]>("/servers", 5000);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [editing, setEditing] = useState<number | null>(null);
  const [actionErr, setActionErr] = useState("");
  const admin = me.role === "admin";
  const act = (p: Promise<unknown>) => p.then(() => { setActionErr(""); reload(); }).catch((e) => setActionErr(e.message));
  return (
    <Section title="MCP servers">
      <Err msg={err || actionErr} />
      {!servers ? <p>Loading…</p> : servers.length === 0 ? <p>No servers registered.</p> : (
        <table>
          <thead><tr><th>Server</th><th>URL</th><th>Status</th><th>Tools</th>{admin && <th>Actions</th>}</tr></thead>
          <tbody>
            {servers.map((s) => [
              <tr key={s.id}>
                <td><b>{s.name}</b><br /><code>{s.slug}</code>{s.hasCredential && <span className="muted"> · {s.authType} credential set</span>}</td>
                <td><code className="url">{s.url}</code></td>
                <td>
                  <span className={`badge ${s.status}`}>{s.status === "connected" ? "Connected" : s.status === "disabled" ? "Disabled" : "Unreachable"}</span>
                  {s.reason && <div className="muted">{s.reason}</div>}
                  <div className="muted">checked {fmt(s.lastChecked)}</div>
                </td>
                <td><button className="link" onClick={() => setOpen({ ...open, [s.id]: !open[s.id] })}>{s.tools.length} tools {open[s.id] ? "▲" : "▼"}</button></td>
                {admin && (
                  <td className="actions">
                    <button onClick={() => act(api(`/servers/${s.id}`, "PATCH", { enabled: !s.enabled }))}>{s.enabled ? "Disable" : "Enable"}</button>
                    <button onClick={() => setEditing(editing === s.id ? null : s.id)}>Edit</button>
                    <button className="danger" onClick={() => confirm(`Remove server ${s.slug}?`) && act(api(`/servers/${s.id}`, "DELETE"))}>Remove</button>
                  </td>
                )}
              </tr>,
              editing === s.id && (
                <tr key={`${s.id}-edit`}><td colSpan={5}><EditServer s={s} onDone={() => { setEditing(null); reload(); }} /></td></tr>
              ),
              open[s.id] && (
                <tr key={`${s.id}-tools`}>
                  <td colSpan={5}>
                    <ul className="tools">{s.tools.map((t) => <li key={t.name}><code>{t.name}</code> — {t.description}</li>)}</ul>
                  </td>
                </tr>
              ),
            ])}
          </tbody>
        </table>
      )}
      {admin && <><h3>Add a server</h3><AddServer onDone={reload} /></>}
    </Section>
  );
}

// ---------- keys ----------
function NewKey({ k, url }: { k: { key: string; name: string }; url: string }) {
  const cmd = `claude mcp add --transport http switchyard ${url} --header "Authorization: Bearer ${k.key}"`;
  return (
    <div className="newkey">
      <p><b>Key "{k.name}" created. Copy it now — it will not be shown again.</b></p>
      <pre>{k.key}</pre>
      <p>Claude Code:</p>
      <pre>{cmd}</pre>
      <button onClick={() => navigator.clipboard.writeText(cmd)}>Copy command</button>
    </div>
  );
}

function KeyTable({ keys, onRevoke }: { keys: Key[]; onRevoke: (id: number) => void }) {
  if (!keys.length) return <p className="muted">No keys yet.</p>;
  return (
    <table>
      <thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k.id}>
            <td>{k.name}</td><td><code>{k.prefix}…</code></td><td>{fmt(k.created_at)}</td><td>{fmt(k.last_used_at)}</td>
            <td>{k.revoked_at ? <span className="badge disabled">Revoked</span> : <span className="badge connected">Active</span>}</td>
            <td>{!k.revoked_at && <button className="danger" onClick={() => onRevoke(k.id)}>Revoke</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Keys({ me }: { me: Me }) {
  const [keys, reload, err] = usePoll<Key[]>("/keys", 15000);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [actionErr, setActionErr] = useState("");
  const create = (e: FormEvent) => {
    e.preventDefault();
    api("/keys", "POST", { name }).then((k) => { setCreated(k); setName(""); reload(); }).catch((e) => setActionErr(e.message));
  };
  const revoke = (id: number) => api(`/keys/${id}`, "DELETE").then(reload).catch((e) => setActionErr(e.message));
  return (
    <Section title="My API keys">
      <p className="muted">Gateway URL: <code>{me.publicMcpUrl}</code> — add it with your key to any MCP client (Claude Code, Cursor, MCP Inspector).</p>
      <form className="row" onSubmit={create}>
        <input placeholder="key name (e.g. laptop)" value={name} onChange={(e) => setName(e.target.value)} />
        <button>Generate key</button>
      </form>
      {created && <NewKey k={created} url={me.publicMcpUrl} />}
      <Err msg={err || actionErr} />
      {keys && <KeyTable keys={keys} onRevoke={revoke} />}
    </Section>
  );
}

// ---------- members (admin) ----------
function Members({ me }: { me: Me }) {
  const [users, reload, err] = usePoll<User[]>("/users", 15000);
  const [f, setF] = useState({ email: "", password: "", role: "member" });
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [actionErr, setActionErr] = useState("");
  const fail = (e: Error) => setActionErr(e.message);
  const add = (e: FormEvent) => {
    e.preventDefault();
    api("/users", "POST", f).then(() => { setF({ email: "", password: "", role: "member" }); setActionErr(""); reload(); }).catch(fail);
  };
  return (
    <Section title="Members">
      <form className="row" onSubmit={add}>
        <input placeholder="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <input placeholder="initial password (8+ chars)" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="member">member</option><option value="admin">admin</option></select>
        <button>Add member</button>
      </form>
      <Err msg={err || actionErr} />
      {created && <NewKey k={created} url={me.publicMcpUrl} />}
      {users?.map((u) => (
        <div key={u.id} className="member">
          <h3>{u.email} <span className="muted">({u.role})</span>{" "}
            <button onClick={() => api(`/users/${u.id}/keys`, "POST", {}).then((k) => { setCreated({ ...k, name: `${k.name} for ${u.email}` }); reload(); }).catch(fail)}>Issue key</button>
          </h3>
          <KeyTable keys={u.keys} onRevoke={(id) => api(`/keys/${id}`, "DELETE").then(reload).catch(fail)} />
        </div>
      ))}
    </Section>
  );
}

// ---------- audit ----------
function AuditLog() {
  const [rows, , err] = usePoll<Audit[]>("/audit", 5000);
  return (
    <Section title="Audit log">
      <p className="muted">Every tool call through the gateway, from MCP clients and from chat. Refreshes every 5 s.</p>
      <Err msg={err} />
      {!rows ? <p>Loading…</p> : rows.length === 0 ? <p>No tool calls yet.</p> : (
        <table>
          <thead><tr><th>Time</th><th>User</th><th>Via</th><th>Server</th><th>Tool</th><th>Duration</th><th>Outcome</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} title={a.args_preview}>
                <td>{fmt(a.ts)}</td><td>{a.user_email}</td><td>{a.source}</td><td>{a.server_slug}</td><td><code>{a.tool}</code></td><td>{a.duration_ms} ms</td>
                <td>{a.outcome === "ok" ? <span className="badge connected">ok</span> : <><span className="badge unreachable">error</span> <span className="muted">{a.error}</span></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

// ---------- chat ----------
function Chat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: input.trim() }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const r = await api<{ reply: string; toolCalls: ToolCall[]; error?: string }>("/chat", "POST", {
        messages: next.filter((m) => !m.error).map(({ role, content }) => ({ role, content })),
      });
      setMsgs([...next, { role: "assistant", content: r.reply, toolCalls: r.toolCalls, error: r.error }]);
    } catch (err) {
      setMsgs([...next, { role: "assistant", content: "", error: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Chat">
      <p className="muted">The agent calls tools through the gateway as you; its calls show up in the audit log under your name.</p>
      <div className="chat">
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.toolCalls?.map((t, j) => (
              <details key={j} className={`call ${t.ok ? "ok" : "bad"}`}>
                <summary>🔧 <code>{t.name}</code> {t.ok ? "ok" : "error"} · {t.durationMs} ms</summary>
                <pre>args: {JSON.stringify(t.arguments, null, 2)}</pre>
                <pre>{t.result}</pre>
              </details>
            ))}
            {m.content && <div className="text">{m.content}</div>}
            {m.error && <p className="err">{m.error}</p>}
          </div>
        ))}
        {busy && <p className="muted">Thinking…</p>}
      </div>
      <form className="row" onSubmit={send}>
        <input className="grow" placeholder='e.g. "What orders came in today?"' value={input} onChange={(e) => setInput(e.target.value)} />
        <button disabled={busy}>Send</button>
        <button type="button" onClick={() => setMsgs([])}>Clear</button>
      </form>
    </Section>
  );
}

// ---------- shell ----------
type Tab = "servers" | "keys" | "members" | "audit" | "chat";

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("servers");
  const loadMe = () => api<Me>("/me").then(setMe).catch(() => setMe(null));
  useEffect(() => { void loadMe(); }, []);

  if (me === undefined) return <p>Loading…</p>;
  if (me === null) return <Login onLogin={loadMe} />;

  const tabs: [Tab, string][] = [["servers", "Servers"], ["keys", "My keys"], ...(me.role === "admin" ? [["members", "Members"] as [Tab, string]] : []), ["audit", "Audit log"], ["chat", "Chat"]];
  return (
    <div className="app">
      <header>
        <b>Switchyard</b>
        <nav>{tabs.map(([t, label]) => <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{label}</button>)}</nav>
        <span className="muted">{me.email} ({me.role})</span>
        <button onClick={() => api("/auth/logout", "POST").then(() => setMe(null))}>Log out</button>
      </header>
      <main>
        {tab === "servers" && <Servers me={me} />}
        {tab === "keys" && <Keys me={me} />}
        {tab === "members" && <Members me={me} />}
        {tab === "audit" && <AuditLog />}
        {tab === "chat" && <Chat />}
      </main>
    </div>
  );
}
