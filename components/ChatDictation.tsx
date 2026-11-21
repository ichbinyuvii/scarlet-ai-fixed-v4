"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import "./voice.css";

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult:
    | ((event: {
        results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
      }) => void)
    | null;
  start(): void;
  abort(): void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
  webkitAudioContext?: typeof AudioContext;
};
type Session = {
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  analyser?: AnalyserNode;
  sink?: GainNode;
  recognition?: Recognition;
  frame?: number;
  openingTimer?: number;
  silenceTimer?: number;
  lastSound: number;
  lastResult: number;
  started: number;
  heard: string;
  wake: boolean;
};
export const voiceLanguages = [
  ["en-US", "English (US)"],
  ["en-GB", "English (UK)"],
  ["en-IN", "English (India)"],
  ["hi-IN", "हिन्दी / Hinglish"],
  ["es-ES", "Español"],
  ["fr-FR", "Français"],
  ["de-DE", "Deutsch"],
  ["ja-JP", "日本語"],
  ["pt-BR", "Português"],
  ["zh-CN", "中文"],
];
const wakePhrase = /^\s*(?:hey[\s,]+scarlett?)\b[\s,.:;!?-]*/i;
const blocked =
  "Microphone or speech access was denied. Allow microphone access in your browser’s site settings, then start listening again.";
const serviceErrors: Record<string, string> = {
  "not-allowed": blocked,
  "service-not-allowed":
    "Your browser’s speech service is unavailable. Type your command or try another supported browser.",
  "audio-capture":
    "No microphone is available. Connect a microphone or check the selected system input.",
  network:
    "The browser speech service could not connect. Check your connection, then try again or type your command.",
  "no-speech": "No speech was recognized. Try again or type your command.",
  "language-not-supported":
    "The speech service does not support this language. Choose another language or type your command.",
};
function constructor() {
  const w = window as SpeechWindow;
  return w.SpeechRecognition || w.webkitSpeechRecognition;
}
function release(s: Session) {
  window.clearTimeout(s.openingTimer);
  window.clearInterval(s.silenceTimer);
  if (s.frame !== undefined) window.cancelAnimationFrame(s.frame);
  if (s.recognition) {
    s.recognition.onstart = null;
    s.recognition.onend = null;
    s.recognition.onerror = null;
    s.recognition.onresult = null;
    try {
      s.recognition.abort();
    } catch {
      /* The service may already be stopped. */
    }
  }
  s.stream?.getTracks().forEach((t) => {
    t.onended = null;
    t.stop();
  });
  s.source?.disconnect();
  s.analyser?.disconnect();
  s.sink?.disconnect();
  if (s.context && s.context.state !== "closed")
    void s.context.close().catch(() => undefined);
}
export function useDictation(onTranscript: (text: string) => void) {
  const receiver = useRef(onTranscript);
  const current = useRef<Session | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<
    "idle" | "opening" | "listening" | "error"
  >("idle");
  const [message, setMessage] = useState("");
  const [interim, setInterim] = useState("");
  const [armed, setArmed] = useState(false);
  const [level, setLevel] = useState(0);
  const [samples, setSamples] = useState<number[]>([]);
  useEffect(() => {
    receiver.current = onTranscript;
  }, [onTranscript]);

  function finish(s: Session, reason: string, error = false, retain = true) {
    if (current.current !== s) return;
    current.current = null;
    release(s);
    setLevel(0);
    setSamples([]);
    setInterim("");
    setArmed(false);
    setPhase(error ? "error" : "idle");
    const review = retain && s.heard.trim();
    if (review) receiver.current(review);
    setMessage(
      reason || (review ? "Transcript ready to review." : "Listening stopped."),
    );
  }

  function stop(retain = true) {
    if (current.current) finish(current.current, "", false, retain);
  }
  useEffect(() => {
    setSupported(
      !!constructor() &&
        window.isSecureContext &&
        !!navigator.mediaDevices?.getUserMedia,
    );
    const hidden = () => {
      if (document.hidden && current.current)
        finish(current.current, "Microphone closed when this tab was hidden.");
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      const s = current.current;
      current.current = null;
      if (s) release(s);
    };
  }, []);

  async function start(language: string, wake = false) {
    if (current.current || document.hidden) return;
    const Engine = constructor();
    if (
      !Engine ||
      !window.isSecureContext ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setPhase("error");
      setMessage(
        "Speech input requires a supported browser on HTTPS or localhost. You can still type your command.",
      );
      return;
    }
    const now = performance.now();
    const s: Session = {
      started: now,
      lastSound: now,
      lastResult: now,
      heard: "",
      wake,
    };
    current.current = s;
    setPhase("opening");
    setMessage("");
    setInterim("");
    setArmed(false);
    setLevel(0);
    setSamples([]);
    s.openingTimer = window.setTimeout(
      () =>
        finish(
          s,
          "Microphone setup timed out. Check the browser permission prompt, then try again.",
          true,
        ),
      15000,
    );
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (current.current !== s) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      s.stream = stream;
      for (const track of stream.getAudioTracks())
        track.onended = () =>
          finish(
            s,
            "The microphone disconnected. Select an available input, then try again.",
            true,
          );
      const Audio =
        window.AudioContext || (window as SpeechWindow).webkitAudioContext;
      if (Audio) {
        s.context = new Audio();
        s.source = s.context.createMediaStreamSource(stream);
        const analyser = s.context.createAnalyser();
        s.analyser = analyser;
        analyser.fftSize = 512;
        s.source.connect(analyser);
        // Keep the analyzer in the active audio graph without echoing the microphone.
        s.sink = s.context.createGain();
        s.sink.gain.value = 0;
        analyser.connect(s.sink);
        s.sink.connect(s.context.destination);
        await s.context.resume();
        if (current.current !== s) return;
        const raw = new Float32Array(analyser.fftSize);
        let prev = 0;
        const sample = (time: number) => {
          if (current.current !== s) return;
          if (time - prev >= 70) {
            analyser.getFloatTimeDomainData(raw);
            let sum = 0;
            for (const v of raw) sum += v * v;
            const rms = Math.sqrt(sum / raw.length);
            if (rms > 0.015) s.lastSound = time;
            setLevel(Math.min(1, rms * 5));
            // Each display column represents measured peak amplitude over ten samples.
            const bins = Array.from({ length: 50 }, (_, i) => {
              let peak = 0;
              for (let j = i * 10; j < i * 10 + 10; j++)
                peak = Math.max(peak, Math.abs(raw[j]));
              return Math.min(1, peak * 3);
            });
            setSamples(bins);
            prev = time;
          }
          s.frame = requestAnimationFrame(sample);
        };
        s.frame = requestAnimationFrame(sample);
      }
      const engine = new Engine();
      s.recognition = engine;
      engine.lang = language;
      engine.continuous = true;
      engine.interimResults = true;
      engine.onstart = () => {
        if (current.current !== s) return;
        window.clearTimeout(s.openingTimer);
        s.started = performance.now();
        s.lastSound = s.started;
        setPhase("listening");
        s.silenceTimer = window.setInterval(() => {
          const time = performance.now();
          if (s.heard && time - Math.max(s.lastSound, s.lastResult) > 1900)
            finish(s, "Transcript ready to review.");
          else if (
            !s.heard &&
            time - s.started > (s.wake ? 45000 : 10000) &&
            time - s.lastSound > 4500
          )
            finish(
              s,
              "No speech was recognized. The microphone is closed. Try again or type your command.",
            );
          else if (time - s.started > 60000)
            finish(s, "The one-minute listening session ended.");
        }, 250);
      };
      engine.onresult = (event) => {
        if (current.current !== s) return;
        const entries = Array.from(event.results);
        const raw = entries
          .map((r) => r[0]?.transcript?.trim() || "")
          .filter(Boolean)
          .join(" ");
        let text = raw;
        if (s.wake) {
          // A wake phrase can be a later result after unrelated background speech.
          const idx = entries.findIndex((r) =>
            wakePhrase.test(r[0]?.transcript || ""),
          );
          if (idx === -1) return;
          text = entries
            .slice(idx)
            .map((r) => r[0].transcript.trim())
            .join(" ")
            .replace(wakePhrase, "");
          setArmed(true);
        }
        s.heard = text.trim().slice(0, 6000);
        s.lastResult = performance.now();
        setInterim(s.heard);
        if (s.heard && entries.at(-1)?.isFinal)
          finish(s, "Transcript ready to review.");
      };
      engine.onerror = (e) =>
        finish(
          s,
          serviceErrors[e.error] ||
            "Speech recognition was interrupted. Try again or type your command.",
          true,
        );
      engine.onend = () =>
        finish(
          s,
          s.heard
            ? "Transcript ready to review."
            : "The speech service stopped before a transcript arrived. Try again or type your command.",
        );
      engine.start();
    } catch (e) {
      const err = e instanceof Error ? e.name : "";
      const reason =
        err === "NotAllowedError" || err === "SecurityError"
          ? blocked
          : err === "NotFoundError" || err === "NotReadableError"
            ? "The microphone could not be opened. Check your system input or close apps using it."
            : "Microphone setup could not complete. Check input and speech permissions, then try again.";
      finish(s, reason, true);
    }
  }
  return {
    phase,
    supported,
    message,
    interim,
    level,
    samples,
    armed,
    start,
    stop,
    clear: () => {
      setMessage("");
      if (!current.current) setPhase("idle");
    },
  };
}
export function InputWaveform({
  samples,
  level,
}: {
  samples: number[];
  level: number;
}) {
  return (
    <div
      className="sv-signal"
      role="meter"
      aria-label="Microphone input level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
    >
      <svg viewBox="0 0 150 26" aria-hidden="true">
        <path d="M0 13H150" className="sv-wave-axis" />
        <path
          className="sv-wave"
          d={samples
            .map(
              (v, i) => "M" + (i * 3 + 1) + " " + (13 - v * 12) + "v" + v * 24,
            )
            .join(" ")}
        />
      </svg>
    </div>
  );
}
export default function ChatDictation({
  onTranscript,
  disabled = false,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [language, setLanguage] = useState("en-US");
  const dictation = useDictation(onTranscript);
  const active =
    dictation.phase === "opening" || dictation.phase === "listening";
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if ((disabled || !open) && active) dictation.stop();
  }, [disabled, open, active, dictation]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!container.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      ref={container}
      className="chat-dictation"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          dictation.stop();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="dictation-trigger"
        aria-label="Chat dictation"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Mic size={17} />
      </button>
      {open && (
        <div
          className="dictation-popover"
          role="group"
          aria-label="Chat dictation settings"
        >
          <label>
            Dictation language
            <select
              value={language}
              disabled={active}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {voiceLanguages.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="dictation-control"
            disabled={disabled || !dictation.supported}
            onClick={() =>
              active ? dictation.stop() : void dictation.start(language)
            }
          >
            {active ? <Square size={13} /> : <Mic size={14} />}{" "}
            {active ? "Finish dictation" : "Start dictation"}
          </button>
          {active && (
            <InputWaveform
              samples={dictation.samples}
              level={dictation.level}
            />
          )}
          <p role={dictation.phase === "error" ? "alert" : "status"}>
            {dictation.supported === false
              ? "Speech recognition is unavailable here. Type in the message field."
              : dictation.interim ||
                dictation.message ||
                "Dictate, then review your message before sending."}
          </p>
        </div>
      )}
    </div>
  );
}
