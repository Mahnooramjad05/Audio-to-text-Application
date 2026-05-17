const { useState, useRef, useCallback } = React;

const API_BASE = "http://127.0.0.1:8000";

const SCENARIOS = [
  { label: "meeting_standup", display: "Meeting Standup", icon: "ti-users", dur: "45s" },
  { label: "customer_support", display: "Customer Support", icon: "ti-headset", dur: "30s" },
  { label: "lecture_excerpt", display: "Lecture Excerpt", icon: "ti-school", dur: "60s" },
  { label: "noisy_interview", display: "Noisy Interview", icon: "ti-microphone", dur: "38s" },
];

const LANG_OPTIONS = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "hi", label: "Hindi" },
];

const MOCK_DATA = {
  meeting_standup: {
    chunk_id: "a1b2c3d4", label: "meeting_standup", language: "en",
    raw_text: "alright team lets get started uh so yesterday i finished the auth module and pushed it to staging today im working on the api rate limiter blocker is we need the db schema approved by sarah before i can continue oh also the CI pipeline is broken someone pushed a bad migration",
    confidence: 0.91, word_count: 52, engine: "mock", language_detected: "en",
    clean_text: "Alright team, let's get started. Yesterday I finished the auth module and pushed it to staging. Today I'm working on the API rate limiter. Blocker: we need the DB schema approved by Sarah. Also, the CI pipeline is broken — someone pushed a bad migration.",
    summary: "Developer completed auth module; blocked on DB schema approval from Sarah. CI pipeline broken due to bad migration.",
    sentiment: "neutral",
    named_entities: [{ text: "Sarah", type: "PERSON" }, { text: "CI pipeline", type: "PRODUCT" }],
    action_items: ["Get DB schema approved by Sarah", "Fix broken CI pipeline migration"],
    topics: ["standup", "auth module", "CI/CD", "rate limiter", "blocker"],
    timings: { ingest_ms: 2, vad_ms: 5, asr_ms: 82, postprocess_ms: 51, total_ms: 140 },
    vad_segments: 8,
  },
  customer_support: {
    chunk_id: "e5f6g7h8", label: "customer_support", language: "en",
    raw_text: "hi yes so i placed an order three days ago order number 4 4 7 2 9 and i havent received any shipping confirmation yet the payment went through on my visa ending 8 8 3 1 can you please check and expedite the shipping",
    confidence: 0.87, word_count: 43, engine: "mock", language_detected: "en",
    clean_text: "Hi, yes. I placed an order three days ago — order #44729 — and I haven't received any shipping confirmation. Payment went through on my Visa ending 8831. Please check and expedite shipping.",
    summary: "Customer placed order #44729 three days ago; no shipping confirmation despite successful Visa payment.",
    sentiment: "negative",
    named_entities: [{ text: "44729", type: "PRODUCT" }, { text: "Visa", type: "ORG" }],
    action_items: ["Check order #44729 status", "Expedite shipping", "Send shipping confirmation"],
    topics: ["order issue", "shipping delay", "customer complaint", "payment"],
    timings: { ingest_ms: 1, vad_ms: 4, asr_ms: 78, postprocess_ms: 48, total_ms: 131 },
    vad_segments: 6,
  },
  lecture_excerpt: {
    chunk_id: "i9j0k1l2", label: "lecture_excerpt", language: "en",
    raw_text: "so as we discussed last week the transformer architecture relies on self attention the key insight is that attention is all you need meaning we dont need recurrence at all the query key value mechanism allows each token to attend to every other token in parallel",
    confidence: 0.95, word_count: 45, engine: "mock", language_detected: "en",
    clean_text: "As we discussed last week, the Transformer architecture relies on self-attention. 'Attention Is All You Need' — we don't need recurrence. The Q-K-V mechanism lets each token attend to every other in parallel.",
    summary: "Lecture explains how Transformer self-attention eliminates recurrence, enabling parallel training far faster than LSTMs.",
    sentiment: "positive",
    named_entities: [{ text: "Attention Is All You Need", type: "PRODUCT" }],
    action_items: [],
    topics: ["transformers", "self-attention", "deep learning", "NLP"],
    timings: { ingest_ms: 1, vad_ms: 3, asr_ms: 74, postprocess_ms: 44, total_ms: 122 },
    vad_segments: 10,
  },
  noisy_interview: {
    chunk_id: "m3n4o5p6", label: "noisy_interview", language: "en",
    raw_text: "yeah so basically um the startup pivoted three times before finding product market fit the original idea was b2b saas for uh logistics companies but the sales cycle was too long so we went consumer and now were at like fifty thousand monthly active users",
    confidence: 0.78, word_count: 44, engine: "mock", language_detected: "en",
    clean_text: "Yeah, the startup pivoted three times before finding product-market fit. Originally B2B SaaS for logistics, but the sales cycle was too long. Went consumer — now at 50K MAU, growing ~15% week over week.",
    summary: "Startup pivoted three times from B2B logistics SaaS to consumer, reaching 50K MAU with 15% weekly growth.",
    sentiment: "positive",
    named_entities: [{ text: "B2B SaaS", type: "PRODUCT" }],
    action_items: [],
    topics: ["startup", "pivot", "product-market fit", "growth", "SaaS"],
    timings: { ingest_ms: 2, vad_ms: 5, asr_ms: 88, postprocess_ms: 53, total_ms: 148 },
    vad_segments: 7,
  },
};

const SENTIMENT_CONFIG = {
  positive: { bg: "#eaf3de", color: "#3b6d11", label: "Positive", icon: "ti-mood-happy" },
  neutral: { bg: "#f1efe8", color: "#5f5e5a", label: "Neutral", icon: "ti-mood-empty" },
  negative: { bg: "#fcebeb", color: "#a32d2d", label: "Negative", icon: "ti-mood-sad" },
};

const ENTITY_COLORS = {
  PERSON: { bg: "#EEEDFE", color: "#3C3489" },
  ORG: { bg: "#E6F1FB", color: "#0C447C" },
  PRODUCT: { bg: "#E1F5EE", color: "#085041" },
  LOCATION: { bg: "#FAECE7", color: "#712B13" },
  DATE: { bg: "#FAEEDA", color: "#633806" },
};

function ConfidenceBar({ value }) {
  const pct = Math.round(value * 100);
  const color = value > 0.85 ? "#3b6d11" : value > 0.7 ? "#854F0B" : "#a32d2d";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
        <span style={{ color: "var(--color-text-secondary)" }}>ASR confidence</span>
        <span style={{ color, fontWeight: 500 }}>{pct}%</span>
      </div>
      <div style={{ background: "var(--color-background-secondary)", borderRadius: 99, height: 6 }}>
        <div style={{ background: color, borderRadius: 99, height: 6, width: `${pct}%`, transition: "width 0.6s ease" }} />
      </div>
    </div>
  );
}

function StatCard({ icon, value, label }) {
  return (
    <div style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "12px 16px", textAlign: "center" }}>
      <i className={`ti ${icon}`} style={{ fontSize: 18, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }} aria-hidden="true" />
      <div style={{ fontSize: 22, fontWeight: 500, lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{label}</div>
    </div>
  );
}

function TimingBar({ timings }) {
  const stages = [
    { key: "ingest_ms", label: "Ingest", color: "#5DCAA5" },
    { key: "vad_ms", label: "VAD", color: "#AFA9EC" },
    { key: "asr_ms", label: "ASR", color: "#378ADD" },
    { key: "postprocess_ms", label: "LLM", color: "#EF9F27" },
  ];
  const total = timings.total_ms || 1;
  return (
    <div>
      <div style={{ display: "flex", gap: 2, height: 8, borderRadius: 99, overflow: "hidden", marginBottom: 8 }}>
        {stages.map(s => (
          <div key={s.key} style={{ flex: timings[s.key] || 0, background: s.color, minWidth: timings[s.key] > 0 ? 2 : 0 }} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {stages.map(s => (
          <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--color-text-secondary)" }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span>{s.label}: </span>
            <span style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>{timings[s.key]}ms</span>
          </div>
        ))}
        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-primary)", marginLeft: "auto" }}>
          Total: {total}ms
        </div>
      </div>
    </div>
  );
}

function ResultPanel({ result }) {
  const [activeTab, setActiveTab] = useState("transcript");
  const sent = SENTIMENT_CONFIG[result.sentiment] || SENTIMENT_CONFIG.neutral;
  const tabs = ["transcript", "analysis"];

  return (
    <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, overflow: "hidden", background: "var(--color-background-primary)" }}>
      <div style={{ padding: "16px 20px 0", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 500, fontSize: 15 }}>
              {result.label.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
            </div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
              ID: <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{result.chunk_id}</code>
              {" · "}{result.engine} · {result.language_detected.toUpperCase()}
            </div>
          </div>
          <div style={{ background: sent.bg, color: sent.color, padding: "4px 12px", borderRadius: 99, fontSize: 12, fontWeight: 500, display: "flex", alignItems: "center", gap: 5 }}>
            <i className={`ti ${sent.icon}`} style={{ fontSize: 14 }} aria-hidden="true" />
            {sent.label}
          </div>
        </div>

        <div style={{ display: "flex", gap: 0 }}>
          {tabs.map(t => (
            <button key={t} onClick={() => setActiveTab(t)} style={{
              background: "none", border: "none", padding: "8px 14px", fontSize: 13,
              fontWeight: activeTab === t ? 500 : 400,
              color: activeTab === t ? "var(--color-text-primary)" : "var(--color-text-secondary)",
              borderBottom: activeTab === t ? "2px solid var(--color-text-primary)" : "2px solid transparent",
              cursor: "pointer", textTransform: "capitalize", borderRadius: 0,
            }}>{t}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: "20px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 20 }}>
          <StatCard icon="ti-file-text" value={result.word_count} label="words" />
          <StatCard icon="ti-clock" value={`${result.timings.total_ms}ms`} label="latency" />
          <StatCard icon="ti-wave-sine" value={result.vad_segments} label="VAD segs" />
          <StatCard icon="ti-percentage" value={`${Math.round(result.confidence * 100)}%`} label="confidence" />
        </div>

        <div style={{ marginBottom: 20 }}>
          <ConfidenceBar value={result.confidence} />
        </div>

        {activeTab === "transcript" && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                Raw ASR output
              </div>
              <div style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "12px 14px", fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.6, borderLeft: "3px solid var(--color-border-secondary)", fontStyle: "italic" }}>
                {result.raw_text}
              </div>
            </div>
            {result.clean_text && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                  Clean transcript
                </div>
                <div style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "12px 14px", fontSize: 14, lineHeight: 1.7, borderLeft: "3px solid #378ADD" }}>
                  {result.clean_text}
                </div>
              </div>
            )}
            {result.summary && (
              <div style={{ background: "#E6F1FB", borderRadius: 8, padding: "12px 14px", fontSize: 14, color: "#0C447C", lineHeight: 1.6, borderLeft: "3px solid #185FA5" }}>
                <i className="ti ti-bulb" style={{ fontSize: 14, marginRight: 6 }} aria-hidden="true" />
                {result.summary}
              </div>
            )}
          </div>
        )}

        {activeTab === "analysis" && (
          <div>
            {result.named_entities.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                  Named entities
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {result.named_entities.map((e, i) => {
                    const ec = ENTITY_COLORS[e.type] || ENTITY_COLORS.PRODUCT;
                    return (
                      <span key={i} style={{ background: ec.bg, color: ec.color, padding: "4px 10px", borderRadius: 6, fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 4 }}>
                        {e.text}
                        <span style={{ fontSize: 10, opacity: 0.7, fontWeight: 400 }}>{e.type}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {result.topics.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                  Topics
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {result.topics.map((t, i) => (
                    <span key={i} style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", color: "var(--color-text-secondary)", padding: "4px 10px", borderRadius: 99, fontSize: 13 }}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {result.action_items.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                  Action items
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {result.action_items.map((a, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 14px", background: "#FAEEDA", borderRadius: 8, borderLeft: "3px solid #EF9F27" }}>
                      <i className="ti ti-checkbox" style={{ fontSize: 15, color: "#854F0B", marginTop: 1, flexShrink: 0 }} aria-hidden="true" />
                      <span style={{ fontSize: 13, color: "#633806", lineHeight: 1.5 }}>{a}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.action_items.length === 0 && result.named_entities.length === 0 && (
              <div style={{ textAlign: "center", padding: "32px 0", color: "var(--color-text-secondary)", fontSize: 14 }}>
                <i className="ti ti-checks" style={{ fontSize: 28, display: "block", marginBottom: 8 }} aria-hidden="true" />
                No action items or entities detected
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
          <div style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
            Pipeline timing
          </div>
          <TimingBar timings={result.timings} />
        </div>
      </div>
    </div>
  );
}

function App() {
  const [selected, setSelected] = useState("meeting_standup");
  const [language, setLanguage] = useState("en");
  const [runVad, setRunVad] = useState(true);
  const [runPost, setRunPost] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [mode, setMode] = useState("demo");
  const fileRef = useRef();

  const runDemo = useCallback(async () => {
    setLoading(true);
    setError(null);
    await new Promise(r => setTimeout(r, 800 + Math.random() * 400));
    setResult(MOCK_DATA[selected]);
    setLoading(false);
  }, [selected]);

  const runLive = useCallback(async () => {
    if (!uploadedFile) return;
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", uploadedFile);
      const params = new URLSearchParams({ language, run_vad: runVad, run_postprocess: runPost });
      const res = await fetch(`${API_BASE}/transcribe?${params}`, { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || "Request failed");
      }
      setResult(await res.json());
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, [uploadedFile, language, runVad, runPost]);

  const handleFile = (e) => {
    const f = e.target.files[0];
    if (f) { setUploadedFile(f); setMode("live"); }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) { setUploadedFile(f); setMode("live"); }
  };

  const startNewSession = () => {
    setResult(null);
    setError(null);
    setUploadedFile(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const saveTranscript = () => {
    if (!result) return;
    const lines = [];
    const title = result.label.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`# ${title}`, "");
    lines.push(`- Engine: ${result.engine}`);
    lines.push(`- Language: ${result.language_detected?.toUpperCase?.() || result.language}`);
    lines.push(`- Confidence: ${Math.round(result.confidence * 100)}%`);
    lines.push(`- Words: ${result.word_count}`);
    lines.push(`- Latency: ${result.timings.total_ms}ms`);
    lines.push("");
    if (result.clean_text) {
      lines.push("## Transcript", "", result.clean_text, "");
    } else if (result.raw_text) {
      lines.push("## Transcript", "", result.raw_text, "");
    }
    if (result.summary) {
      lines.push("## Summary", "", result.summary, "");
    }
    if (result.topics?.length) {
      lines.push("## Topics", "", ...result.topics.map(t => `- ${t}`), "");
    }
    if (result.action_items?.length) {
      lines.push("## Action Items", "", ...result.action_items.map(a => `- ${a}`), "");
    }
    if (result.named_entities?.length) {
      lines.push("## Named Entities", "", ...result.named_entities.map(e => `- ${e.text} (${e.type})`), "");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result.label || "transcript"}-${result.chunk_id}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--color-background-tertiary)", fontFamily: "var(--font-sans)" }}>
      <h2 className="sr-only">Audio Transcription Pipeline — upload audio or select a demo scenario to get a transcript, summary, sentiment, and action items.</h2>

      <div style={{ background: "var(--color-background-primary)", borderBottom: "0.5px solid var(--color-border-tertiary)", padding: "0 24px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", alignItems: "center", height: 56, gap: 12 }}>
          <i className="ti ti-waveform" style={{ fontSize: 22, color: "var(--color-text-primary)" }} aria-hidden="true" />
          <span style={{ fontWeight: 500, fontSize: 16 }}>Transcription Pipeline</span>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px", display: "grid", gridTemplateColumns: "220px 1fr", gap: 20, alignItems: "start" }}>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
              Input mode
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {[["demo", "ti-player-play", "Demo"], ["live", "ti-upload", "Live API"]].map(([m, ic, lb]) => (
                <button key={m} onClick={() => setMode(m)} style={{
                  flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                  padding: "10px 8px", borderRadius: 8, border: "0.5px solid",
                  borderColor: mode === m ? "var(--color-border-primary)" : "var(--color-border-tertiary)",
                  background: mode === m ? "var(--color-background-secondary)" : "var(--color-background-primary)",
                  cursor: "pointer", fontSize: 12,
                  color: mode === m ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                }}>
                  <i className={`ti ${ic}`} style={{ fontSize: 16 }} aria-hidden="true" />
                  {lb}
                </button>
              ))}
            </div>
          </div>

          <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
              Configuration
            </div>

            {mode === "demo" ? (
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>
                  Scenario
                </label>
                <select value={selected} onChange={e => setSelected(e.target.value)}
                  style={{ width: "100%", fontSize: 13 }}>
                  {SCENARIOS.map(s => (
                    <option key={s.label} value={s.label}>{s.display} ({s.dur})</option>
                  ))}
                </select>
              </div>
            ) : (
              <div
                onDrop={handleDrop} onDragOver={e => e.preventDefault()}
                onClick={() => fileRef.current.click()}
                style={{
                  border: "1px dashed var(--color-border-secondary)", borderRadius: 8,
                  padding: "16px 12px", textAlign: "center", cursor: "pointer",
                  marginBottom: 14, transition: "background 0.15s",
                }}>
                <i className="ti ti-cloud-upload" style={{ fontSize: 20, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }} aria-hidden="true" />
                {uploadedFile ? (
                  <div style={{ fontSize: 12, color: "var(--color-text-primary)", wordBreak: "break-all" }}>{uploadedFile.name}</div>
                ) : (
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Drop WAV/MP3 or click</div>
                )}
                <input ref={fileRef} type="file" accept="audio/*" onChange={handleFile} style={{ display: "none" }} />
              </div>
            )}

            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>Language</label>
              <select value={language} onChange={e => setLanguage(e.target.value)} style={{ width: "100%", fontSize: 13 }}>
                {LANG_OPTIONS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>

            {[["runVad", runVad, setRunVad, "Voice Activity Detection"], ["runPost", runPost, setRunPost, "LLM post-processing"]].map(([k, val, setter, lbl]) => (
              <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 8, fontSize: 13 }}>
                <input type="checkbox" checked={val} onChange={e => setter(e.target.checked)} style={{ flexShrink: 0 }} />
                <span style={{ color: "var(--color-text-secondary)" }}>{lbl}</span>
              </label>
            ))}

            <button
              onClick={mode === "demo" ? runDemo : runLive}
              disabled={loading || (mode === "live" && !uploadedFile)}
              style={{
                width: "100%", marginTop: 8, padding: "10px", borderRadius: 8,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                fontSize: 14, fontWeight: 500, cursor: loading ? "wait" : "pointer",
                opacity: (mode === "live" && !uploadedFile) ? 0.5 : 1,
              }}>
              {loading ? (
                <>
                  <i className="ti ti-loader-2" style={{ fontSize: 15, animation: "spin 1s linear infinite" }} aria-hidden="true" />
                  Processing...
                </>
              ) : (
                <>
                  <i className="ti ti-player-play" style={{ fontSize: 15 }} aria-hidden="true" />
                  {mode === "demo" ? "Run demo" : "Transcribe"}
                </>
              )}
            </button>
          </div>

        </div>

        <div>
          {error && (
            <div style={{ background: "#fcebeb", border: "0.5px solid #f09595", borderRadius: 10, padding: "12px 16px", marginBottom: 16, display: "flex", gap: 10, alignItems: "flex-start" }}>
              <i className="ti ti-alert-circle" style={{ fontSize: 16, color: "#a32d2d", marginTop: 1 }} aria-hidden="true" />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#791F1F" }}>API error</div>
                <div style={{ fontSize: 12, color: "#a32d2d", marginTop: 2 }}>{error}</div>
                <div style={{ fontSize: 12, color: "#a32d2d", marginTop: 4 }}>
                  Make sure the FastAPI server is running: <code style={{ fontFamily: "var(--font-mono)" }}>python server.py</code>
                </div>
              </div>
            </div>
          )}

          {!result && !loading && (
            <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: "60px 24px", textAlign: "center" }}>
              <i className="ti ti-waveform" style={{ fontSize: 40, color: "var(--color-text-secondary)", display: "block", marginBottom: 16 }} aria-hidden="true" />
              <div style={{ fontWeight: 500, fontSize: 16, marginBottom: 8 }}>Ready to transcribe</div>
              <div style={{ fontSize: 14, color: "var(--color-text-secondary)", maxWidth: 380, margin: "0 auto" }}>
                Select a demo scenario or upload an audio file, then click "Run demo" to see the full pipeline output.
              </div>
              <div style={{ marginTop: 24, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                {SCENARIOS.map(s => (
                  <button key={s.label} onClick={() => { setSelected(s.label); setMode("demo"); runDemo(); }}
                    style={{ padding: "8px 14px", borderRadius: 99, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
                             background: "var(--color-background-secondary)", color: "var(--color-text-primary)", border: "0.5px solid var(--color-border-tertiary)" }}>
                    <i className={`ti ${s.icon}`} style={{ fontSize: 14 }} aria-hidden="true" />
                    {s.display}
                  </button>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: "60px 24px", textAlign: "center" }}>
              <i className="ti ti-loader-2" style={{ fontSize: 36, color: "var(--color-text-secondary)", display: "block", marginBottom: 12, animation: "spin 1s linear infinite" }} aria-hidden="true" />
              <div style={{ fontWeight: 500, marginBottom: 6 }}>Running pipeline</div>
              <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Ingest → VAD → ASR → LLM post-processing</div>
              <div style={{ maxWidth: 260, margin: "20px auto 0", background: "var(--color-background-secondary)", borderRadius: 99, height: 4, overflow: "hidden" }}>
                <div style={{ height: "100%", background: "#378ADD", animation: "indeterminate 1.5s ease-in-out infinite", borderRadius: 99 }} />
              </div>
            </div>
          )}

          {result && !loading && (
            <>
              <ResultPanel result={result} />
              <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end" }}>
                <button onClick={startNewSession} style={{
                  background: "var(--color-background-primary)",
                  color: "var(--color-text-primary)",
                  border: "0.5px solid var(--color-border-secondary)",
                  padding: "10px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500,
                  display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                }}>
                  <i className="ti ti-refresh" style={{ fontSize: 15 }} aria-hidden="true" />
                  Start new session
                </button>
                <button onClick={saveTranscript} style={{
                  padding: "10px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500,
                  display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                }}>
                  <i className="ti ti-download" style={{ fontSize: 15 }} aria-hidden="true" />
                  Save transcript
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes indeterminate {
          0% { width: 0%; margin-left: 0%; }
          50% { width: 60%; margin-left: 20%; }
          100% { width: 0%; margin-left: 100%; }
        }
        .sr-only { position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0; }
      `}</style>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
