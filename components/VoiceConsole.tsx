"use client";

import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Captions,
  Headphones,
  Mic,
  MicOff,
  Radio,
  Send,
  SlidersHorizontal,
  Square,
  Volume2,
} from "lucide-react";
import CoreVisual, { type CoreState } from "./CoreVisual";
import { InputWaveform, useDictation, voiceLanguages } from "./ChatDictation";
import "./voice.css";

export interface VoiceConsoleProps {
  onCommand: (text: string) => Promise<string>;
}
type OutputState = "idle" | "thinking" | "speaking" | "error";
const phaseLabel = {
  idle: "Standby",
  opening: "Opening microphone",
  listening: "Listening",
  thinking: "Processing command",
  speaking: "Speaking",
  error: "Attention required",
  review: "Review transcript",
};
export function VoiceConsole({ onCommand }: VoiceConsoleProps) {
  const [language, setLanguage] = useState("en-US"),
    [voice, setVoice] = useState("");
  const [spoken, setSpoken] = useState(true),
    [muted, setMuted] = useState(false),
    [wake, setWake] = useState(false);
  const [typed, setTyped] = useState(""),
    [lastInput, setLastInput] = useState(""),
    [reply, setReply] = useState("");
  const [output, setOutput] = useState<OutputState>("idle"),
    [message, setMessage] = useState("");
  const [playback, setPlayback] = useState(false),
    [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speechLevel, setSpeechLevel] = useState(0),
    [review, setReview] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null),
    mounted = useRef(false),
    working = useRef(false);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null),
    timer = useRef<number | undefined>(undefined);
  const readAloud = useRef(spoken);
  readAloud.current = spoken;
  const capture = useDictation((text) => {
    setTyped((prev) =>
      (prev.trimEnd() ? prev.trimEnd() + " " + text : text).slice(0, 6000),
    );
    setReview(true);
    if (!document.hidden)
      requestAnimationFrame(() =>
        editor.current?.focus({ preventScroll: true }),
      );
  });
  const active = capture.phase === "opening" || capture.phase === "listening";
  const phase = active
    ? capture.phase
    : output !== "idle"
      ? output
      : capture.phase === "error"
        ? "error"
        : review
          ? "review"
          : "idle";
  const coreState: CoreState =
    phase === "opening" || phase === "review" ? "idle" : phase;

  function interrupt() {
    if (utterance.current) {
      const active = utterance.current;
      active.onend = null;
      active.onerror = null;
      active.onboundary = null;
      utterance.current = null;
      window.speechSynthesis?.cancel();
    }
    window.clearTimeout(timer.current);
    setSpeechLevel(0);
  }
  useEffect(() => {
    mounted.current = true;
    const synth = window.speechSynthesis;
    setPlayback(!!synth);
    const load = () => setVoices(synth?.getVoices() || []);
    load();
    synth?.addEventListener("voiceschanged", load);
    const hide = () => {
      if (document.hidden && utterance.current) {
        interrupt();
        setOutput("idle");
      }
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      mounted.current = false;
      interrupt();
      synth?.removeEventListener("voiceschanged", load);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  function speak(text: string) {
    interrupt();
    if (!text || !window.speechSynthesis || document.hidden) {
      setOutput("idle");
      return;
    }
    const speech = new SpeechSynthesisUtterance(text);
    speech.lang = language;
    speech.voice =
      window.speechSynthesis.getVoices().find((v) => v.voiceURI === voice) ??
      null;
    utterance.current = speech;
    speech.onboundary = () => {
      setSpeechLevel(0.7);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setSpeechLevel(0.1), 130);
    };
    speech.onend = () => {
      utterance.current = null;
      window.clearTimeout(timer.current);
      setSpeechLevel(0);
      setOutput("idle");
    };
    speech.onerror = () => {
      utterance.current = null;
      window.clearTimeout(timer.current);
      setSpeechLevel(0);
      setOutput("error");
      setMessage(
        "Audio playback could not complete. Your reply is available in the transcript.",
      );
    };
    setOutput("speaking");
    window.speechSynthesis.speak(speech);
  }
  async function send() {
    const command = typed.trim();
    if (!command || working.current || active) return;
    working.current = true;
    capture.clear();
    interrupt();
    setOutput("thinking");
    setMessage("");
    setLastInput(command);
    setReply("");
    setReview(false);
    try {
      const answer = await onCommand(command);
      if (!mounted.current) return;
      setTyped("");
      setReply(answer);
      if (readAloud.current && playback) speak(answer);
      else setOutput("idle");
    } catch (e) {
      if (mounted.current) {
        setMessage(
          e instanceof Error
            ? e.message
            : "The command could not complete. Your draft is ready to retry.",
        );
        setOutput("error");
        setTyped(command);
        setReview(true);
      }
    } finally {
      working.current = false;
    }
  }
  function listen() {
    if (active) {
      capture.stop();
      return;
    }
    if (working.current || muted) return;
    interrupt();
    setOutput("idle");
    setMessage("");
    void capture.start(language, wake);
  }
  const heading =
    phase === "listening" && wake
      ? capture.armed
        ? "Say your command"
        : "Awaiting wake phrase"
      : phaseLabel[phase];
  const text = message || capture.message;
  const inputHint =
    phase === "opening"
      ? "Allow microphone access when your browser asks."
      : wake && !capture.armed
        ? "Say “Hey Scarlet”, followed by your command."
        : "Speak, then review the transcript before sending.";
  const availableVoices = voices.filter(
    (v) => v.lang.split(/[-_]/)[0].toLowerCase() === language.split("-")[0],
  );
  return (
    <section className="scarlet-voice" aria-label="Voice console">
      <div className="sv-instrument">
        <div className="sv-instrument-bar">
          <span>
            <Radio size={15} />
            Voice channel
          </span>
          <span>
            <i className={"sv-indicator sv-" + phase} />
            {phaseLabel[phase]}
          </span>
        </div>
        <div className="sv-stage">
          <CoreVisual
            state={coreState}
            level={phase === "speaking" ? speechLevel : capture.level}
          />
        </div>
        <div className="sv-console-panel">
          <span className="sv-eyebrow">
            <Headphones size={14} /> Audio link
          </span>
          <h2 role="status">{heading}</h2>
          <p>
            {active
              ? capture.interim || inputHint
              : phase === "review"
                ? "Edit the captured words below, then send your command."
                : phase === "thinking"
                  ? "Waiting for the command response."
                  : phase === "speaking"
                    ? "Start listening to interrupt playback."
                    : "Open the microphone to speak with Scarlet."}
          </p>
          {active && (
            <InputWaveform samples={capture.samples} level={capture.level} />
          )}
          <div className="sv-actions">
            <button
              className="sv-primary"
              type="button"
              disabled={!capture.supported || muted || phase === "thinking"}
              onClick={listen}
            >
              {active ? <Square size={15} /> : <Mic size={17} />}{" "}
              {active ? "Stop listening" : "Start listening"}
            </button>
            {phase === "speaking" ? (
              <button
                type="button"
                className="sv-plain"
                onClick={() => {
                  interrupt();
                  setOutput("idle");
                }}
              >
                <Square size={14} />
                Stop playback
              </button>
            ) : (
              <button
                type="button"
                className="sv-plain"
                disabled={!capture.supported}
                aria-pressed={muted}
                onClick={() => {
                  if (!muted) capture.stop();
                  setMuted(!muted);
                }}
              >
                {muted ? <Mic size={16} /> : <MicOff size={16} />}{" "}
                {muted ? "Unmute input" : "Mute input"}
              </button>
            )}
          </div>
        </div>
      </div>
      {text && (
        <p className="sv-notice" role={phase === "error" ? "alert" : "status"}>
          {text}
        </p>
      )}
      {capture.supported === false && (
        <p className="sv-notice">
          Speech recognition is unavailable here. Type a command below or open a
          supported browser on HTTPS or localhost.
        </p>
      )}
      <div className="sv-lower">
        <div className="sv-section">
          <h3>
            <SlidersHorizontal size={18} />
            Voice settings
          </h3>
          <div className="sv-selects">
            <label>
              Language
              <select
                value={language}
                disabled={active}
                onChange={(e) => {
                  setLanguage(e.target.value);
                  setVoice("");
                }}
              >
                {voiceLanguages.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Playback voice
              <select
                value={voice}
                disabled={!playback}
                onChange={(e) => setVoice(e.target.value)}
              >
                <option value="">Device default</option>
                {availableVoices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="sv-check">
            <Volume2 size={16} />
            <span>Read replies aloud</span>
            <input
              type="checkbox"
              disabled={!playback}
              checked={spoken && playback}
              onChange={(e) => {
                setSpoken(e.target.checked);
                if (!e.target.checked && utterance.current) {
                  interrupt();
                  setOutput("idle");
                }
              }}
            />
          </label>
          <label className="sv-check">
            <AudioLines size={16} />
            <span>Wake phrase “Hey Scarlet”</span>
            <input
              type="checkbox"
              disabled={!capture.supported || active || phase === "thinking"}
              checked={wake}
              onChange={(e) => setWake(e.target.checked)}
            />
          </label>
          <p className="sv-hint">
            Wake listening starts when you open the microphone. Capture closes
            during review, after silence, and when the tab is hidden. Your
            browser may use its online speech service.
          </p>
        </div>
        <div className="sv-section">
          <h3>
            <Captions size={18} />
            Session transcript
          </h3>
          <div className="sv-transcript" aria-live="polite">
            {lastInput ? (
              <>
                <span>You</span>
                <p>{lastInput}</p>
                {reply && (
                  <>
                    <span>Scarlet</span>
                    <p>{reply}</p>
                  </>
                )}
              </>
            ) : (
              <p>Your submitted command and reply will appear here.</p>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label className="sv-review-label" htmlFor="voice-command">
              {review ? "Review your transcript" : "Command draft"}
            </label>
            <div className="sv-compose">
              <textarea
                id="voice-command"
                ref={editor}
                rows={2}
                aria-label="Typed voice command"
                placeholder="Type or dictate a command…"
                value={typed}
                maxLength={6000}
                disabled={phase === "thinking"}
                onChange={(e) => setTyped(e.target.value)}
              />
              <button
                type="submit"
                aria-label="Send typed command"
                disabled={!typed.trim() || active || phase === "thinking"}
              >
                <Send size={16} />
              </button>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}
export default VoiceConsole;
