"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type AppState = "IDLE" | "LISTENING" | "PROCESSING" | "RESULT" | "ERROR";

interface DemandResponse {
  speech: string;
  status: string;
  action?: string;
  data?: unknown;
}

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

export default function Home() {
  const [state, setState] = useState<AppState>("IDLE");
  const [recognizedText, setRecognizedText] = useState("");
  const [responseText, setResponseText] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [wakeLockActive, setWakeLockActive] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listeningRef = useRef(false);
  const sessionIdRef = useRef<string>("");
  const transcriptRef = useRef<string>("");

  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "pt-BR";
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = () => {
      setState("IDLE");
      setResponseText("");
    };
    utterance.onerror = () => {
      setState("IDLE");
    };
    window.speechSynthesis.speak(utterance);
  }, []);

  const requestWakeLock = useCallback(async () => {
    if (typeof window === "undefined" || !("wakeLock" in navigator)) return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
      setWakeLockActive(true);
      wakeLockRef.current.addEventListener("release", () => {
        setWakeLockActive(false);
      });
    } catch {
      setWakeLockActive(false);
    }
  }, []);

  const reacquireWakeLock = useCallback(async () => {
    if (typeof document === "undefined" || !wakeLockRef.current) return;
    if (document.visibilityState === "visible" && !wakeLockActive) {
      await requestWakeLock();
    }
  }, [requestWakeLock, wakeLockActive]);

  useEffect(() => {
    requestWakeLock();

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        reacquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
      }
    };
  }, [requestWakeLock, reacquireWakeLock]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const SpeechRecognition =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setErrorMessage("Seu navegador não suporta reconhecimento de voz.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "pt-BR";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = "";
      let interimTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      if (finalTranscript) {
        transcriptRef.current = (transcriptRef.current + " " + finalTranscript.trim()).trim();
        setRecognizedText(transcriptRef.current);
      } else {
        const interim = interimTranscript.trim();
        setRecognizedText(
          (transcriptRef.current ? transcriptRef.current + " " : "") + interim
        );
      }

      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        if (listeningRef.current) {
          stopListening();
        }
      }, 1500);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === "no-speech") {
        setErrorMessage("Nenhuma fala detectada.");
        setState("ERROR");
      } else if (event.error === "audio-capture") {
        setErrorMessage("Problema ao capturar áudio.");
        setState("ERROR");
      } else if (event.error === "not-allowed") {
        setErrorMessage("Permissão de microfone negada.");
        setState("ERROR");
      } else {
        setErrorMessage("Erro no reconhecimento de voz.");
        setState("ERROR");
      }
      listeningRef.current = false;
    };

    recognition.onend = () => {
      if (listeningRef.current) {
        setState("PROCESSING");
        processRecognizedText();
      }
    };

    recognitionRef.current = recognition;
  }, []);

  const processRecognizedText = async () => {
    const text = transcriptRef.current.trim();
    if (!text) {
      setErrorMessage("Nenhuma fala detectada.");
      setState("ERROR");
      return;
    }

    try {
      const response = await fetch("/api/demand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          timestamp: new Date().toISOString(),
          sessionId: sessionIdRef.current,
        }),
      });

      const data = (await response.json()) as DemandResponse;

      if (!response.ok || data.status === "error" || !data.speech) {
        setErrorMessage(data.speech || "Erro ao processar a demanda.");
        setState("ERROR");
        return;
      }

      setResponseText(data.speech);
      setState("RESULT");
      speak(data.speech);
    } catch {
      setErrorMessage("Erro de comunicação com o assistente.");
      setState("ERROR");
    }
  };

  const startListening = () => {
    if (!recognitionRef.current) {
      setErrorMessage("Reconhecimento de voz não disponível.");
      setState("ERROR");
      return;
    }

    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    sessionIdRef.current = crypto.randomUUID();
    transcriptRef.current = "";
    setRecognizedText("");
    setResponseText("");
    setErrorMessage("");
    setState("LISTENING");
    listeningRef.current = true;

    try {
      recognitionRef.current.start();
    } catch {
      setErrorMessage("Não foi possível iniciar o microfone.");
      setState("ERROR");
      listeningRef.current = false;
    }
  };

  const stopListening = () => {
    listeningRef.current = false;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    recognitionRef.current?.stop();
  };

  useEffect(() => {
    if (state === "ERROR") {
      const timer = setTimeout(() => {
        setState("IDLE");
        setErrorMessage("");
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [state]);

  const statusConfig: Record<AppState, { label: string; color: string; textColor: string }> = {
    IDLE: { label: "Toque para falar", color: "bg-zinc-800", textColor: "text-zinc-50" },
    LISTENING: { label: "Ouvindo...", color: "bg-blue-600", textColor: "text-white" },
    PROCESSING: { label: "Processando...", color: "bg-amber-500", textColor: "text-black" },
    RESULT: { label: "Resposta", color: "bg-emerald-600", textColor: "text-white" },
    ERROR: { label: "Erro", color: "bg-red-600", textColor: "text-white" },
  };

  const current = statusConfig[state];

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <div
        className={`flex flex-col items-center justify-center gap-8 rounded-3xl px-8 py-12 text-center shadow-2xl transition-all duration-500 ${current.color} ${current.textColor} max-w-3xl w-full`}
      >
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Alexo</h1>

        <button
          onClick={state === "LISTENING" ? stopListening : startListening}
          disabled={state === "PROCESSING" || state === "RESULT"}
          className="flex h-48 w-48 items-center justify-center rounded-full bg-white/20 text-6xl font-bold backdrop-blur-sm transition-transform hover:scale-105 active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
          aria-label={state === "LISTENING" ? "Parar de ouvir" : "Falar com o Alexo"}
        >
          {state === "LISTENING" ? "⏹" : "🎤"}
        </button>

        <p className="text-2xl font-semibold sm:text-3xl">{current.label}</p>

        {state === "LISTENING" && recognizedText && (
          <p className="text-xl opacity-90">{recognizedText}</p>
        )}

        {state === "RESULT" && responseText && (
          <p className="text-2xl font-medium leading-relaxed">{responseText}</p>
        )}

        {state === "ERROR" && errorMessage && (
          <p className="text-xl font-medium">{errorMessage}</p>
        )}
      </div>

      <div className="mt-8 flex items-center gap-2 text-sm text-zinc-500">
        <span className={`h-2 w-2 rounded-full ${wakeLockActive ? "bg-emerald-500" : "bg-zinc-600"}`} />
        <span>{wakeLockActive ? "Tela mantida ligada" : "Wake lock inativo"}</span>
      </div>
    </div>
  );
}
