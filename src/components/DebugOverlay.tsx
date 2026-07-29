"use client";

import { useEffect, useRef, useState } from "react";

type LogLevel = "log" | "info" | "warn" | "error";

interface LogEntry {
  id: number;
  level: LogLevel;
  message: string;
  time: string;
}

const MAX_ENTRIES = 200;
let nextId = 0;

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export default function DebugOverlay() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const entriesRef = useRef<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const push = (level: LogLevel, args: unknown[]) => {
      const entry: LogEntry = {
        id: nextId++,
        level,
        message: args.map(formatArg).join(" "),
        time: new Date().toLocaleTimeString("pt-BR", { hour12: false }),
      };
      entriesRef.current = [...entriesRef.current, entry].slice(-MAX_ENTRIES);
      setEntries(entriesRef.current);
    };

    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };

    console.log = (...args: unknown[]) => {
      push("log", args);
      original.log(...args);
    };
    console.info = (...args: unknown[]) => {
      push("info", args);
      original.info(...args);
    };
    console.warn = (...args: unknown[]) => {
      push("warn", args);
      original.warn(...args);
    };
    console.error = (...args: unknown[]) => {
      push("error", args);
      original.error(...args);
    };

    const handleError = (event: ErrorEvent) => {
      push("error", [`Uncaught: ${event.message}`, event.error]);
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      push("error", ["Unhandled rejection:", event.reason]);
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);

    return () => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, open]);

  const levelColor: Record<LogLevel, string> = {
    log: "text-zinc-200",
    info: "text-blue-300",
    warn: "text-amber-300",
    error: "text-red-400",
  };

  return (
    <>
      <button
        onClick={() => setOpen((value) => !value)}
        className="fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-black/70 text-xl text-white shadow-lg"
        aria-label="Alternar painel de depuração"
      >
        🐞
      </button>
      {open && (
        <div className="fixed inset-x-2 bottom-20 top-16 z-40 flex flex-col rounded-xl bg-black/90 text-xs text-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-white/20 px-3 py-2">
            <span className="font-semibold">Debug ({entries.length})</span>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  entriesRef.current = [];
                  setEntries([]);
                }}
                className="rounded bg-white/10 px-2 py-1"
              >
                Limpar
              </button>
              <button onClick={() => setOpen(false)} className="rounded bg-white/10 px-2 py-1">
                Fechar
              </button>
            </div>
          </div>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 font-mono">
            {entries.length === 0 && <p className="text-zinc-500">Sem logs ainda.</p>}
            {entries.map((entry) => (
              <p key={entry.id} className={`${levelColor[entry.level]} mb-1 whitespace-pre-wrap break-words`}>
                <span className="text-zinc-500">[{entry.time}]</span> {entry.message}
              </p>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
