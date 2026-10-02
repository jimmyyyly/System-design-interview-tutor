import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { computeLoad, critique, type LoadMultiplier } from "../../src/shared/analysis.js";
import { PHASES, type ChatEntry, type Component, type Design, type Phase, type SessionSnapshot } from "../../src/shared/types.js";
import { createSession, getConfig, getSession, sendMessage } from "./api.js";
import { Diagram, utilClass } from "./Diagram.js";
import { Markdown } from "./Markdown.js";

const EXAMPLES = ["Design a URL shortener", "Design Discord", "Design Twitter's home timeline", "Design YouTube", "Design Uber"];
const MULTIPLIERS = [1, 3, 10, 100];

const PHASE_LABEL: Record<Phase, string> = {
  requirements: "Requirements",
  estimation: "Estimation",
  high_level: "High level",
  deep_dive: "Deep dive",
  scaling: "Scaling",
  wrap_up: "Wrap-up",
};

type Mode = "claude" | "offline";

function sessionIdFromHash() {
  const m = location.hash.match(/s=([\w-]+)/);
  return m ? m[1]! : null;
}

export function App() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [defaultMode, setDefaultMode] = useState<Mode>("offline");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getConfig()
      .then((c) => setDefaultMode(c.defaultMode))
      .catch(() => {});
    const id = sessionIdFromHash();
    if (!id) return setLoading(false);
    getSession(id)
      .then(setSnapshot)
      .catch(() => (location.hash = ""))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;
  if (!snapshot) {
    return (
      <Start
        defaultMode={defaultMode}
        onStart={(s) => {
          location.hash = `s=${s.id}`;
          setSnapshot(s);
        }}
      />
    );
  }
  return (
    <Interview
      key={snapshot.id}
      initial={snapshot}
      onNew={() => {
        location.hash = "";
        setSnapshot(null);
      }}
    />
  );
}

function Start({ defaultMode, onStart }: { defaultMode: Mode; onStart: (s: SessionSnapshot) => void }) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setMode(defaultMode), [defaultMode]);

  const start = async (p: string) => {
    if (!p.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onStart(await createSession(p.trim(), mode));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="start">
      <div className="start-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          System Design Tutor
        </div>
        <h1>What are we designing today?</h1>
        <p className="muted">
          You'll scope it, estimate it, and build the architecture piece by piece. The tutor draws as you go and pushes back on
          your choices.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start(prompt);
          }}
          className="start-form"
        >
          <input
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Design a URL shortener"
            aria-label="Interview prompt"
            maxLength={200}
          />
          <button type="submit" disabled={busy || !prompt.trim()}>
            Start interview
          </button>
        </form>
        <div className="chips">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip" disabled={busy} onClick={() => void start(ex)}>
              {ex.replace(/^Design (an? )?/, "")}
            </button>
          ))}
        </div>
        <div className="mode-select" role="radiogroup" aria-label="Tutor mode">
          <label className={mode === "claude" ? "on" : ""}>
            <input type="radio" name="mode" checked={mode === "claude"} onChange={() => setMode("claude")} />
            Claude tutor
            <span className="muted">adaptive interviewer, needs an API key on the server</span>
          </label>
          <label className={mode === "offline" ? "on" : ""}>
            <input type="radio" name="mode" checked={mode === "offline"} onChange={() => setMode("offline")} />
            Offline
            <span className="muted">scripted, rule-based pushback, no key needed</span>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

function Interview({ initial, onNew }: { initial: SessionSnapshot; onNew: () => void }) {
  const [design, setDesign] = useState<Design>(initial.design);
  const [transcript, setTranscript] = useState<ChatEntry[]>(initial.transcript);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [mult, setMult] = useState<LoadMultiplier>({ read: 1, write: 1 });
  const [tab, setTab] = useState<"pushback" | "weak" | "reqs">("pushback");
  const started = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);

  const flash = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setHighlighted((h) => new Set([...h, ...ids]));
    setTimeout(() => {
      setHighlighted((h) => {
        const next = new Set(h);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }, 2200);
  }, []);

  const send = useCallback(
    async (text: string | null) => {
      setBusy(true);
      setError(null);
      if (text !== null) setTranscript((t) => [...t, { role: "user", text }]);
      let acc = "";
      setStreaming("");
      try {
        await sendMessage(initial.id, text, (e) => {
          if (e.type === "text") {
            acc += e.delta;
            setStreaming(acc);
          } else if (e.type === "design") {
            setDesign(e.design);
            flash(e.changed);
          } else if (e.type === "error") {
            setError(e.message);
          }
        });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (acc.trim()) setTranscript((t) => [...t, { role: "tutor", text: acc.trim() }]);
        setStreaming(null);
        setBusy(false);
      }
    },
    [initial.id, flash],
  );

  // Kick off the opening turn for a fresh session.
  useEffect(() => {
    if (started.current || initial.transcript.length > 0) return;
    started.current = true;
    void send(null);
  }, [initial.transcript.length, send]);

  useEffect(() => {
    logRef.current?.scrollTo({
      top: logRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [transcript, streaming]);

  const load = useMemo(() => computeLoad(design, mult), [design, mult]);
  const findings = useMemo(() => critique(design), [design]);
  const openChallenges = design.challenges.filter((c) => c.status === "open");
  const selectedComponent = design.components.find((c) => c.id === selected) ?? null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void send(text);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="title" title={design.title}>
            {design.title}
          </span>
        </div>
        <ol className="phases" aria-label="Interview phase">
          {PHASES.map((p, i) => {
            const cur = PHASES.indexOf(design.phase);
            return (
              <li key={p} className={i < cur ? "done" : i === cur ? "current" : ""}>
                {PHASE_LABEL[p]}
              </li>
            );
          })}
        </ol>
        <div className="topbar-right">
          <span className={`mode-pill ${initial.mode}`}>{initial.mode === "claude" ? "Claude" : "Offline"}</span>
          <button className="ghost" onClick={onNew}>
            New interview
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="chat" aria-label="Conversation">
          <div className="log" ref={logRef}>
            {transcript.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.role === "tutor" ? <Markdown text={m.text} /> : <p>{m.text}</p>}
              </div>
            ))}
            {streaming !== null && (
              <div className="msg tutor streaming">
                {streaming ? <Markdown text={streaming} /> : <span className="typing" aria-label="Tutor is thinking" />}
              </div>
            )}
            {error && <div className="msg system">{error}</div>}
          </div>
          <div className="quick">
            <button disabled={busy} onClick={() => void send("I'm stuck. Can I get a hint?")}>
              Hint
            </button>
            <button disabled={busy} onClick={() => void send("What happens at 10x write volume? What breaks first?")}>
              Stress: 10x writes
            </button>
            <button
              disabled={busy}
              onClick={() => void send("Let's wrap up. Evaluate my design: strengths, gaps, and how I'd score as a candidate.")}
            >
              Wrap up
            </button>
          </div>
          <form className="composer" onSubmit={submit}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) submit(e);
              }}
              placeholder={busy ? "Tutor is responding…" : "Propose components, answer the question, defend your choice…"}
              rows={3}
              aria-label="Your message"
            />
            <button type="submit" disabled={busy || !draft.trim()}>
              Send
            </button>
          </form>
        </section>

        <section className="board" aria-label="Whiteboard">
          <div className="board-toolbar">
            <LoadControl label="Reads" value={mult.read} onChange={(read) => setMult((m) => ({ ...m, read }))} />
            <LoadControl label="Writes" value={mult.write} onChange={(write) => setMult((m) => ({ ...m, write }))} />
            <div className="legend">
              {load ? (
                <>
                  <span>
                    {fmtNum(load.readQps)} reads/s · {fmtNum(load.writeQps)} writes/s
                  </span>
                  <span className="dot cool" /> ok <span className="dot warm" /> &gt;70% <span className="dot hot" /> saturated
                </>
              ) : (
                <span className="muted">Load model activates once scale estimates are on the board</span>
              )}
            </div>
          </div>
          <div className="canvas">
            <Diagram design={design} load={load} highlighted={highlighted} selected={selected} onSelect={setSelected} />
            {selectedComponent && (
              <Inspector c={selectedComponent} load={load} design={design} onClose={() => setSelected(null)} />
            )}
          </div>
          <div className="panels">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === "pushback"} onClick={() => setTab("pushback")}>
                Pushback {openChallenges.length > 0 && <span className="count">{openChallenges.length}</span>}
              </button>
              <button role="tab" aria-selected={tab === "weak"} onClick={() => setTab("weak")}>
                Weak spots {findings.length > 0 && <span className="count muted-count">{findings.length}</span>}
              </button>
              <button role="tab" aria-selected={tab === "reqs"} onClick={() => setTab("reqs")}>
                Requirements
              </button>
            </div>
            <div className="tab-body">
              {tab === "pushback" &&
                (design.challenges.length === 0 ? (
                  <p className="muted">Pointed questions from the tutor get pinned here.</p>
                ) : (
                  <ul className="challenges">
                    {[...design.challenges].reverse().map((c) => (
                      <li key={c.id} className={`challenge ${c.severity} ${c.status}`}>
                        <span className="sev">{c.status === "open" ? c.severity : c.status}</span>
                        <span className="q">{c.question}</span>
                        {c.resolution && <span className="res">{c.resolution}</span>}
                      </li>
                    ))}
                  </ul>
                ))}
              {tab === "weak" &&
                (findings.length === 0 ? (
                  <p className="muted">No automated findings right now. That doesn't mean the design is done.</p>
                ) : (
                  <ul className="challenges">
                    {findings.map((f) => (
                      <li key={f.id} className={`challenge ${f.severity}`} onMouseEnter={() => flash(f.targetIds)}>
                        <span className="sev">{f.severity}</span>
                        <span className="q">{f.message}</span>
                      </li>
                    ))}
                  </ul>
                ))}
              {tab === "reqs" && <Requirements design={design} />}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function LoadControl({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="load-control" role="group" aria-label={`${label} multiplier`}>
      <span>{label}</span>
      {MULTIPLIERS.map((m) => (
        <button key={m} className={m === value ? "on" : ""} onClick={() => onChange(m)} aria-pressed={m === value}>
          {m}×
        </button>
      ))}
    </div>
  );
}

function Inspector({
  c,
  load,
  design,
  onClose,
}: {
  c: Component;
  load: ReturnType<typeof computeLoad>;
  design: Design;
  onClose: () => void;
}) {
  const l = load?.components[c.id];
  const ins = design.edges.filter((e) => e.to === c.id).map((e) => e.from);
  const outs = design.edges.filter((e) => e.from === c.id).map((e) => e.to);
  return (
    <aside className="inspector" aria-label={`${c.label} details`}>
      <button className="close" onClick={onClose} aria-label="Close details">
        ×
      </button>
      <h3>{c.label}</h3>
      <dl>
        <dt>Kind</dt>
        <dd>{c.kind.replace("_", " ")}</dd>
        {c.tech && (
          <>
            <dt>Tech</dt>
            <dd>{c.tech}</dd>
          </>
        )}
        <dt>Replicas</dt>
        <dd>{c.replicas ?? 1}</dd>
        <dt>Shards</dt>
        <dd>
          {c.shards ?? 1}
          {c.shardKey ? ` by ${c.shardKey}` : ""}
        </dd>
        {l && (
          <>
            <dt>Load</dt>
            <dd className={utilClass(l.utilization)}>
              {Math.round(l.utilization * 100)}% ({l.bottleneck}-bound)
            </dd>
            <dt>Demand</dt>
            <dd>
              {fmtNum(l.readDemand)} r/s · {fmtNum(l.writeDemand)} w/s
            </dd>
          </>
        )}
        {ins.length > 0 && (
          <>
            <dt>From</dt>
            <dd>{ins.join(", ")}</dd>
          </>
        )}
        {outs.length > 0 && (
          <>
            <dt>To</dt>
            <dd>{outs.join(", ")}</dd>
          </>
        )}
      </dl>
      {c.notes && <p className="notes">{c.notes}</p>}
    </aside>
  );
}

function Requirements({ design }: { design: Design }) {
  const r = design.requirements;
  const s = r.scale;
  const empty = !r.functional.length && !r.nonFunctional.length && !Object.keys(s).length;
  if (empty) return <p className="muted">Agreed requirements and estimates land here.</p>;
  return (
    <div className="reqs">
      {r.functional.length > 0 && (
        <div>
          <h4>Functional</h4>
          <ul>
            {r.functional.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      {r.nonFunctional.length > 0 && (
        <div>
          <h4>Non-functional</h4>
          <ul>
            {r.nonFunctional.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      {Object.keys(s).length > 0 && (
        <div>
          <h4>Scale</h4>
          <ul className="scale">
            {s.dau !== undefined && <li>{fmtNum(s.dau)} DAU</li>}
            {s.readQps !== undefined && <li>{fmtNum(s.readQps)} reads/s</li>}
            {s.writeQps !== undefined && <li>{fmtNum(s.writeQps)} writes/s</li>}
            {s.storageTb !== undefined && <li>{fmtNum(s.storageTb)} TB</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function fmtNum(n: number) {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
}
