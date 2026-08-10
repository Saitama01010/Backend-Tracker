import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AvatarName } from "@/components/AvatarName";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/authContext";
import { ChevronDown, ChevronLeft, ChevronRight, Clock, Maximize2, Minimize2, Paperclip, Send, Sparkles, Users, X } from "lucide-react";

interface SamiaMessage { role: "user" | "assistant"; content: string; images?: string[] }
interface HistoryGroup { key: string; label: string; preview: string; messages: SamiaMessage[] }
interface SamiaMutation { resource: string; action: string; [key: string]: unknown }
interface SamiaResponse {
  reply?: string;
  error?: string;
  fallbackUsed?: boolean;
  mutations?: SamiaMutation[];
  invalidateQueryKeys?: string[];
}

type ChatSize = "normal" | "minimized" | "maximized";

export default function SamiaChat({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [size, setSize] = useState<ChatSize>("normal");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<SamiaMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  // Name gate
  const [chatName, setChatName] = useState<string>(() => localStorage.getItem("samia_display_name") ?? "");
  const [nameInput, setNameInput] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  // Admin "All chats" state
  const [adminView, setAdminView] = useState<"chat" | "users" | "viewUser" | "history" | "viewDate">("chat");
  const [adminUsers, setAdminUsers] = useState<{ userId: number; username: string }[]>([]);
  const [adminViewUser, setAdminViewUser] = useState<{ userId: number; username: string } | null>(null);
  const [adminMessages, setAdminMessages] = useState<SamiaMessage[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  // Personal chat history (grouped by date)
  const [historyGroups, setHistoryGroups] = useState<HistoryGroup[]>([]);
  const [historyGroup, setHistoryGroup] = useState<HistoryGroup | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { token, user } = useUser();
  const qc = useQueryClient();
  const isAdmin = user.role === "admin";
  if (!isAdmin) return null;

  function submitName() {
    const n = nameInput.trim();
    if (!n) return;
    localStorage.setItem("samia_display_name", n);
    setChatName(n);
  }

  useEffect(() => {
    if (open) {
      setTimeout(() => {
        if (!chatName) { nameRef.current?.focus(); return; }
        inputRef.current?.focus();
      }, 80);
      if (!historyLoaded) {
        const hr = new Date().getHours();
        const timeGreet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
        const greeting = { role: "assistant" as const, content: `${timeGreet}. I'm Samia — I know every number in this dashboard cold. What do you need?` };
        // Start each session clean — past conversations live behind the History button.
        setMessages([greeting]);
        setHistoryLoaded(true);
      }
    }
  }, [open]);

  function openAdminUsers() {
    setAdminView("users");
    setAdminLoading(true);
    apiFetch("/api/samia/users", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : [])
      .then((rows: { userId: number; username: string }[]) => setAdminUsers(rows))
      .catch(() => setAdminUsers([]))
      .finally(() => setAdminLoading(false));
  }

  function viewUserChat(u: { userId: number; username: string }) {
    setAdminViewUser(u);
    setAdminView("viewUser");
    setAdminLoading(true);
    apiFetch(`/api/samia/history/${u.userId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : [])
      .then((rows: Array<{ role: string; content: string; images?: string[] | null }>) =>
        setAdminMessages(rows.map((r) => ({ role: r.role as "user" | "assistant", content: r.content, images: r.images ?? undefined })))
      )
      .catch(() => setAdminMessages([]))
      .finally(() => setAdminLoading(false));
  }

  function openHistory() {
    setAdminView("history");
    setHistoryLoading(true);
    apiFetch("/api/samia/history", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : [])
      .then((rows: Array<{ role: string; content: string; images?: string[] | null; createdAt: string }>) => {
        const byKey = new Map<string, HistoryGroup>();
        const order: string[] = [];
        const today = new Date().toLocaleDateString("en-CA");
        const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("en-CA");
        for (const r of rows) {
          const d = new Date(r.createdAt);
          const key = d.toLocaleDateString("en-CA");
          let g = byKey.get(key);
          if (!g) {
            const label = key === today ? "Today" : key === yesterday ? "Yesterday"
              : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
            g = { key, label, preview: "", messages: [] };
            byKey.set(key, g);
            order.push(key);
          }
          g.messages.push({ role: r.role as "user" | "assistant", content: r.content, images: r.images ?? undefined });
        }
        // Preview = first user line of the day (fallback to first message)
        for (const g of byKey.values()) {
          const firstUser = g.messages.find((m) => m.role === "user" && m.content.trim());
          const src = (firstUser ?? g.messages[0])?.content ?? "";
          g.preview = src.length > 60 ? src.slice(0, 60) + "…" : src || "(image only)";
        }
        // Newest day first
        setHistoryGroups(order.map((k) => byKey.get(k)!).reverse());
      })
      .catch(() => setHistoryGroups([]))
      .finally(() => setHistoryLoading(false));
  }

  function viewHistoryDate(g: HistoryGroup) {
    setHistoryGroup(g);
    setAdminView("viewDate");
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function readFileAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function addImages(files: FileList | File[]) {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/")).slice(0, 4);
    const urls = await Promise.all(arr.map(readFileAsDataURL));
    setPendingImages((prev) => [...prev, ...urls].slice(0, 4));
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith("image/"));
    if (items.length === 0) return;
    e.preventDefault();
    const files = items.map((i) => i.getAsFile()).filter(Boolean) as File[];
    void addImages(files);
  }

  async function send() {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || loading) return;
    const images = [...pendingImages];
    setInput("");
    setPendingImages([]);
    setMessages((prev) => [...prev, { role: "user", content: text, images: images.length ? images : undefined }]);
    setLoading(true);
    try {
      const res = await apiFetch("/api/samia/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: text || "What do you see in this image?", images, displayName: chatName || undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as SamiaResponse;
      if (res.ok && data.invalidateQueryKeys?.length) {
        await Promise.all([...new Set(data.invalidateQueryKeys)].map((key) =>
          qc.invalidateQueries({ queryKey: [key], refetchType: "active" })));
        const resources = [...new Set((data.mutations ?? []).map((mutation) => mutation.resource))];
        window.dispatchEvent(new CustomEvent<{ resources: string[]; mutations: SamiaMutation[] }>("dashboard:data-changed", {
          detail: { resources, mutations: data.mutations ?? [] },
        }));
      }
      const note = data.fallbackUsed ? "\n\nUsed backup model." : "";
      const content = res.ok
        ? data.reply ?? "The action completed without a response."
        : data.error ?? data.reply ?? `Request failed with HTTP ${res.status}.`;
      setMessages((prev) => [...prev, { role: "assistant", content: `${content}${note}` }]);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "Network error — try again." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Floating bubble */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-6 right-6 z-50 h-14 w-14 rounded-full bg-primary text-white shadow-lg flex items-center justify-center hover:scale-105 transition-transform"
        aria-label="Open Samia"
      >
        {open ? <X className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
      </button>

      {/* Chat panel */}
      {open && (
        <div className={`fixed z-50 flex flex-col rounded-2xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl shadow-2xl overflow-hidden transition-all duration-200 ${
          size === "maximized"
            ? "bottom-4 right-4 left-4 top-4 w-auto max-h-none"
            : size === "minimized"
            ? "bottom-24 right-4 sm:right-6 w-[calc(100vw-32px)] sm:w-[360px] max-h-none"
            : "bottom-24 right-4 sm:right-6 w-[calc(100vw-32px)] sm:w-[360px] max-h-[560px]"
        }`}>
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-white/8 bg-muted/40 flex-shrink-0">
            {(adminView === "users" || adminView === "viewUser" || adminView === "history" || adminView === "viewDate") ? (
              <button onClick={() => adminView === "viewUser" ? setAdminView("users") : adminView === "viewDate" ? setAdminView("history") : setAdminView("chat")} className="text-zinc-400 hover:text-white transition-colors p-1 -ml-1">
                <ChevronLeft className="h-4 w-4" />
              </button>
            ) : (
              <div className="h-9 w-9 rounded-full bg-primary flex items-center justify-center text-white font-bold text-sm shadow-md flex-shrink-0">S</div>
            )}
            <div>
              <p className="text-sm font-semibold text-white leading-none">
                {adminView === "users" ? "All Chats" : adminView === "viewUser" ? adminViewUser?.username ?? "User" : adminView === "history" ? "Chat History" : adminView === "viewDate" ? historyGroup?.label ?? "Chat" : "Samia"}
              </p>
              <p className="text-[10px] metric-info mt-0.5 flex items-center gap-1">
                {adminView === "chat" && <><span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse" />AI Analyst · Live data</>}
                {adminView === "users" && "Select a user to view their chat"}
                {adminView === "viewUser" && "Read-only · Admin view"}
                {adminView === "history" && "Your past conversations by date"}
                {adminView === "viewDate" && "Read-only · Past conversation"}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-1">
              {/* Personal chat history button */}
              {adminView === "chat" && (
                <button onClick={openHistory} title="Chat history" className="text-zinc-500 hover:metric-info transition-colors p-1">
                  <Clock className="h-4 w-4" />
                </button>
              )}
              {/* Admin all-chats button */}
              {isAdmin && adminView === "chat" && (
                <button onClick={openAdminUsers} title="View all user chats" className="text-zinc-500 hover:metric-info transition-colors p-1">
                  <Users className="h-4 w-4" />
                </button>
              )}
              {/* Minimize */}
              <button
                onClick={() => setSize((s) => s === "minimized" ? "normal" : "minimized")}
                title={size === "minimized" ? "Restore" : "Minimize"}
                className="text-zinc-500 hover:text-white transition-colors p-1"
              >
                <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${size === "minimized" ? "rotate-180" : ""}`} />
              </button>
              {/* Maximize */}
              <button
                onClick={() => setSize((s) => s === "maximized" ? "normal" : "maximized")}
                title={size === "maximized" ? "Restore" : "Maximize"}
                className="text-zinc-500 hover:text-white transition-colors p-1"
              >
                {size === "maximized" ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
              {/* Close */}
              <button onClick={() => { setOpen(false); setSize("normal"); setAdminView("chat"); setHistoryGroup(null); }} className="text-zinc-500 hover:text-white transition-colors p-1">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Name gate — shown if user hasn't set their display name yet */}
          {!chatName ? (
            <div className="flex-1 flex flex-col items-center justify-center px-6 py-8 gap-5">
              <div className="h-14 w-14 rounded-full bg-primary flex items-center justify-center text-white font-bold text-xl shadow-lg">S</div>
              <div className="text-center">
                <p className="text-sm font-semibold text-white mb-1">Hey, before we start —</p>
                <p className="text-xs text-zinc-400">What's your name? Samia will use it to remember you.</p>
              </div>
              <div className="w-full flex gap-2">
                <input
                  ref={nameRef}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitName(); }}
                  placeholder="Your first name…"
                  className="flex-1 text-sm rounded-xl bg-zinc-800 border border-white/10 px-3 py-2.5 text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  onClick={submitName}
                  disabled={!nameInput.trim()}
                  className="px-4 rounded-xl bg-primary text-white text-sm font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
                >
                  Go
                </button>
              </div>
            </div>
          ) : adminView === "users" ? (
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1 min-h-0">
              {adminLoading && (
                <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs py-6">
                  <div className="h-3 w-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
                  Loading…
                </div>
              )}
              {!adminLoading && adminUsers.length === 0 && (
                <p className="text-center text-xs text-zinc-500 py-6">No chat history yet.</p>
              )}
              {adminUsers.map((u) => (
                <button
                  key={u.userId}
                  onClick={() => viewUserChat(u)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 transition-colors text-left"
                >
                  <AvatarName name={u.username} size="md" textClassName="text-sm text-white" />
                  <ChevronRight className="h-4 w-4 text-zinc-600 ml-auto" />
                </button>
              ))}
            </div>
          ) : adminView === "viewUser" ? (
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
              {adminLoading && (
                <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs py-4">
                  <div className="h-3 w-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
                  Loading…
                </div>
              )}
              {!adminLoading && adminMessages.length === 0 && (
                <p className="text-center text-xs text-zinc-500 py-6">No messages yet.</p>
              )}
              {adminMessages.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  {m.role === "assistant" && (
                    <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center text-white text-[10px] font-bold mr-2 mt-0.5 flex-shrink-0">S</div>
                  )}
                  <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === "user" ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-zinc-800 text-zinc-100 rounded-bl-sm"
                  }`}>{m.content}</div>
                </div>
              ))}
            </div>
          ) : adminView === "history" ? (
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1 min-h-0">
              {historyLoading && (
                <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs py-6">
                  <div className="h-3 w-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
                  Loading…
                </div>
              )}
              {!historyLoading && historyGroups.length === 0 && (
                <p className="text-center text-xs text-zinc-500 py-6">No past conversations yet.</p>
              )}
              {historyGroups.map((g) => (
                <button
                  key={g.key}
                  onClick={() => viewHistoryDate(g)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 transition-colors text-left"
                >
                  <div className="h-8 w-8 rounded-full bg-zinc-700 flex items-center justify-center metric-info flex-shrink-0">
                    <Clock className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white leading-tight">{g.label}</p>
                    <p className="text-[11px] text-zinc-500 truncate">{g.preview}</p>
                  </div>
                  <span className="text-[10px] text-zinc-600 flex-shrink-0">{g.messages.length} msg</span>
                  <ChevronRight className="h-4 w-4 text-zinc-600 flex-shrink-0" />
                </button>
              ))}
            </div>
          ) : adminView === "viewDate" ? (
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
              {(historyGroup?.messages ?? []).length === 0 && (
                <p className="text-center text-xs text-zinc-500 py-6">No messages.</p>
              )}
              {(historyGroup?.messages ?? []).map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  {m.role === "assistant" && (
                    <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center text-white text-[10px] font-bold mr-2 mt-0.5 flex-shrink-0">S</div>
                  )}
                  <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === "user" ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-zinc-800 text-zinc-100 rounded-bl-sm"
                  }`}>{m.content}</div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {/* Normal chat messages */}
              <div className={`flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0 ${size === "minimized" ? "hidden" : ""}`}>
                {historyLoading && (
                  <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs py-4">
                    <div className="h-3 w-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
                    Loading memory…
                  </div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    {m.role === "assistant" && (
                      <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center text-white text-[10px] font-bold mr-2 mt-0.5 flex-shrink-0">S</div>
                    )}
                    <div className={`max-w-[80%] flex flex-col gap-1.5 ${m.role === "user" ? "items-end" : "items-start"}`}>
                      {m.images?.map((src, idx) => (
                        <img key={idx} src={src} alt="attachment" className="max-w-[220px] rounded-xl border border-white/10 object-cover" />
                      ))}
                      {m.content && (
                        <div className={`rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                          m.role === "user" ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-zinc-800 text-zinc-100 rounded-bl-sm"
                        }`}>{m.content}</div>
                      )}
                    </div>
                  </div>
                ))}
                {loading && (
                  <div className="flex justify-start">
                    <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center text-white text-[10px] font-bold mr-2 mt-0.5 flex-shrink-0">S</div>
                    <div className="bg-zinc-800 rounded-2xl rounded-bl-sm px-3 py-2">
                      <div className="flex gap-1 items-center h-4">
                        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:0ms]" />
                        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:150ms]" />
                        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:300ms]" />
                      </div>
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              {/* Input bar */}
              <div className={`px-3 pb-3 pt-2 border-t border-white/8 flex flex-col gap-2 ${size === "minimized" ? "hidden" : ""}`}>
                {pendingImages.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {pendingImages.map((src, idx) => (
                      <div key={idx} className="relative group">
                        <img src={src} alt="pending" className="h-16 w-16 rounded-lg object-cover border border-white/10" />
                        <button
                          onClick={() => setPendingImages((p) => p.filter((_, i) => i !== idx))}
                          className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-zinc-700 border border-white/20 text-zinc-300 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 items-center">
                  <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden"
                    onChange={(e) => { if (e.target.files) { void addImages(e.target.files); e.target.value = ""; } }} />
                  <button onClick={() => fileInputRef.current?.click()} disabled={loading} title="Attach image"
                    className="h-9 w-9 rounded-xl bg-zinc-800 border border-white/10 text-zinc-400 hover:metric-info flex items-center justify-center transition-colors disabled:opacity-40 flex-shrink-0">
                    <Paperclip className="h-4 w-4" />
                  </button>
                  <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                    onPaste={handlePaste} placeholder="Ask Samia anything… or paste a screenshot" disabled={loading}
                    className="flex-1 text-sm rounded-xl bg-zinc-800 border border-white/10 px-3 py-2 text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50" />
                  <button onClick={() => void send()} disabled={(!input.trim() && pendingImages.length === 0) || loading}
                    className="h-9 w-9 rounded-xl bg-primary text-white flex items-center justify-center disabled:opacity-40 hover:opacity-90 transition-opacity flex-shrink-0">
                    <Send className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
