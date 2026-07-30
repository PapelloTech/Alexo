"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Microphone } from "openwakeword-web/microphone";
import type { OpenWakeWord } from "openwakeword-web";
import { clientConfig } from "@/lib/config";

type AppState = "IDLE" | "LISTENING" | "PROCESSING" | "SPEAKING" | "RESULT" | "ERROR";
type DemandEvent = "utterance" | "cancel";
type ResponseStatus = "need_input" | "confirming" | "success" | "cancelled" | "error";

type Slots = Record<string, string | null | undefined>;

interface ConversationData {
  slots?: Slots;
  missing?: string[];
}

interface DemandResponse {
  speech?: string;
  status?: ResponseStatus;
  expectsReply?: boolean;
  sessionId?: string;
  data?: ConversationData;
}

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent {
  error: string;
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

const slotLabels: Record<string, string> = {
  titulo: "Título",
  responsavel: "Responsável",
  sistema: "Sistema",
  prazo: "Prazo",
  criterioAceitacao: "Critério",
};

function getSpeechRecognitionConstructor(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === "undefined") return undefined;
  const browserWindow = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return browserWindow.SpeechRecognition || browserWindow.webkitSpeechRecognition;
}

function useIsClient() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

function useIsSpeechSupported() {
  return useSyncExternalStore(
    () => () => {},
    () => !!getSpeechRecognitionConstructor(),
    () => true
  );
}

export default function Home() {
  const [state, setState] = useState<AppState>("IDLE");
  const [recognizedText, setRecognizedText] = useState("");
  const [lastUtterance, setLastUtterance] = useState("");
  const [responseText, setResponseText] = useState("");
  const [responseStatus, setResponseStatus] = useState<ResponseStatus | null>(null);
  const [conversationData, setConversationData] = useState<ConversationData | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [wakeWordStatus, setWakeWordStatus] = useState("");
  const isClient = useIsClient();
  const isSpeechSupported = useIsSpeechSupported();

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const wakeEngineRef = useRef<{ engine: OpenWakeWord; microphone: Microphone } | null>(null);
  const speechTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const postTtsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const networkControllerRef = useRef<AbortController | null>(null);
  const activeRecognitionRef = useRef(false);
  const ignoreRecognitionEventsRef = useRef(false);
  const processOnEndRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const transcriptRef = useRef("");
  const awaitingReplyRef = useRef(false);
  const beginListeningRef = useRef<(continuation: boolean, deadline?: number, resetTranscript?: boolean) => Promise<void>>(async () => undefined);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const mountedRef = useRef(true);

  const clearTimer = useCallback((timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      await wakeLockRef.current.release().catch(() => undefined);
      wakeLockRef.current = null;
    }
  }, []);

  const requestWakeLock = useCallback(async () => {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    await releaseWakeLock();
    wakeLockRef.current = await navigator.wakeLock.request("screen").catch(() => null);
  }, [releaseWakeLock]);

  const stopWakeWord = useCallback(async () => {
    const wakeWord = wakeEngineRef.current;
    wakeEngineRef.current = null;
    if (!wakeWord) return;

    await wakeWord.microphone.stop().catch(() => undefined);
    await wakeWord.engine.reset().catch(() => undefined);
  }, []);

  const discardSession = useCallback(() => {
    sessionIdRef.current = null;
    awaitingReplyRef.current = false;
    setAwaitingReply(false);
  }, []);

  const clearConversation = useCallback(() => {
    discardSession();
    transcriptRef.current = "";
    setRecognizedText("");
    setLastUtterance("");
    setResponseText("");
    setResponseStatus(null);
    setConversationData(null);
    clearTimer(speechTimeoutRef);
    clearTimer(conversationTimeoutRef);
    clearTimer(postTtsTimeoutRef);
  }, [clearTimer, discardSession]);

  const stopRecognition = useCallback((abort = false) => {
    clearTimer(speechTimeoutRef);
    const recognition = recognitionRef.current;
    if (!recognition || !activeRecognitionRef.current) return;
    ignoreRecognitionEventsRef.current = true;
    if (abort) recognition.abort();
    else recognition.stop();
  }, [clearTimer]);

  const returnToIdle = useCallback(() => {
    stopRecognition(true);
    window.speechSynthesis.cancel();
    networkControllerRef.current?.abort();
    networkControllerRef.current = null;
    clearTimer(resultTimeoutRef);
    clearConversation();
    setErrorMessage("");
    setState("IDLE");
  }, [clearConversation, clearTimer, stopRecognition]);

  const sendDemand = useCallback(async (event: DemandEvent, text = "") => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      console.warn("[Alexo] sendDemand abortado: sem sessionId", { event, text });
      return null;
    }

    networkControllerRef.current?.abort();
    const controller = new AbortController();
    networkControllerRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), clientConfig.networkTimeoutMs);

    console.log("[Alexo] sendDemand ->", { event, text, sessionId });
    try {
      const response = await fetch("/api/demand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, text, sessionId, timestamp: new Date().toISOString() }),
        signal: controller.signal,
      });
      const data = (await response.json()) as DemandResponse;
      console.log("[Alexo] sendDemand <-", { status: response.status, data });
      if (!response.ok) throw new Error(data.speech || "Erro ao processar a demanda.");
      return data;
    } catch (error) {
      console.error("[Alexo] sendDemand erro", error);
      throw error;
    } finally {
      clearTimeout(timeout);
      if (networkControllerRef.current === controller) networkControllerRef.current = null;
    }
  }, []);

  const startWakeWord = useCallback(async () => {
    if (
      !mountedRef.current ||
      state !== "IDLE" ||
      !clientConfig.wakeWordEnabled ||
      wakeEngineRef.current
    ) return;

    try {
      const [{ OpenWakeWord, configureOrt }, { Microphone }] = await Promise.all([
        import("openwakeword-web"),
        import("openwakeword-web/microphone"),
      ]);
      configureOrt({ numThreads: 1 });
      const engine = await OpenWakeWord.create({
        baseUrl: "/openwakeword/models/",
        wakewordModels: [{ name: "alexo", url: clientConfig.wakeWordModelPath }],
        threshold: 0.5,
        onDetection: () => {
          console.log("[Alexo] wake word detectado");
          if (mountedRef.current) {
            setWakeWordStatus("");
            void stopWakeWord();
            window.dispatchEvent(new Event("alexo-wake-word"));
          }
        },
      });
      const microphone = new Microphone(
        (frame) => void engine.predict(frame),
        { workletUrl: "/openwakeword/mic-worklet.js" }
      );
      if (!mountedRef.current || state !== "IDLE") {
        await engine.reset();
        return;
      }
      wakeEngineRef.current = { engine, microphone };
      await microphone.start();
      setWakeWordStatus("Diga Alexo para começar");
      console.log("[Alexo] wake word ativo");
    } catch (error) {
      console.error("[Alexo] erro ao iniciar wake word", error);
      await stopWakeWord();
      setWakeWordStatus("Ativação por voz indisponível. Use Falar.");
    }
  }, [state, stopWakeWord]);

  const scheduleResultReset = useCallback(() => {
    clearTimer(resultTimeoutRef);
    resultTimeoutRef.current = setTimeout(() => returnToIdle(), clientConfig.resultDisplayMs);
  }, [clearTimer, returnToIdle]);

  const processUtterance = useCallback((text: string) => {
    setLastUtterance(text);
    setRecognizedText("");
    setState("PROCESSING");
    void (async () => {
      try {
        const response = await sendDemand("utterance", text);
        if (!response) return;
        if (response.sessionId !== sessionIdRef.current || !response.speech || !response.status || typeof response.expectsReply !== "boolean") {
          console.error("[Alexo] resposta invalida do assistente", response);
          throw new Error("Resposta inválida do assistente.");
        }
        if (!(["need_input", "confirming", "success", "cancelled", "error"] as string[]).includes(response.status)) {
          throw new Error("Resposta inválida do assistente.");
        }
        setResponseText(response.speech);
        setResponseStatus(response.status);
        setConversationData(response.data ?? null);
        awaitingReplyRef.current = response.expectsReply;
        setState("SPEAKING");
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(response.speech);
        utterance.lang = "pt-BR";
        utterance.onend = () => {
          console.log("[Alexo] TTS onend", { expectsReply: response.expectsReply });
          if (response.expectsReply && sessionIdRef.current === response.sessionId) {
            postTtsTimeoutRef.current = setTimeout(() => void beginListeningRef.current(true), clientConfig.postTtsDelayMs);
          } else {
            discardSession();
            setState("RESULT");
            scheduleResultReset();
          }
        };
        utterance.onerror = (event) => {
          console.error("[Alexo] TTS onerror", event);
          discardSession();
          setErrorMessage("Não foi possível reproduzir a resposta.");
          setState("ERROR");
          scheduleResultReset();
        };
        window.speechSynthesis.speak(utterance);
      } catch (error) {
        console.error("[Alexo] erro ao processar utterance", error);
        discardSession();
        setErrorMessage(error instanceof Error ? error.message : "Erro de comunicação com o assistente.");
        setState("ERROR");
        scheduleResultReset();
      }
    })();
  }, [discardSession, scheduleResultReset, sendDemand]);

  const beginListening = useCallback(async (
    continuation: boolean,
    deadline = Date.now() + (continuation ? clientConfig.replyTimeoutMs : clientConfig.initialSpeechTimeoutMs),
    resetTranscript = true
  ) => {
    const SpeechRecognition = getSpeechRecognitionConstructor();
    if (!SpeechRecognition) {
      setErrorMessage("Seu navegador não suporta reconhecimento de voz.");
      setState("ERROR");
      scheduleResultReset();
      return;
    }

    await stopWakeWord();
    clearTimer(speechTimeoutRef);
    ignoreRecognitionEventsRef.current = false;
    if (resetTranscript) {
      transcriptRef.current = "";
      setRecognizedText("");
    }
    setErrorMessage("");
    setState("LISTENING");
    awaitingReplyRef.current = continuation;
    setAwaitingReply(continuation);

    const recognition = new SpeechRecognition();
    recognition.lang = "pt-BR";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognitionRef.current = recognition;

    const baseTranscript = transcriptRef.current;
    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let index = 0; index < event.results.length; index += 1) {
        const text = event.results[index][0].transcript.trim();
        if (event.results[index].isFinal) finalText += `${text} `;
        else interimText += `${text} `;
      }
      transcriptRef.current = `${baseTranscript} ${finalText}`.trim();
      setRecognizedText(`${transcriptRef.current} ${interimText}`.trim());
      clearTimer(speechTimeoutRef);
      speechTimeoutRef.current = setTimeout(() => {
        if (activeRecognitionRef.current) {
          processOnEndRef.current = Boolean(transcriptRef.current.trim());
          recognition.stop();
        }
      }, 1_500);
    };

    recognition.onerror = (event) => {
      console.warn("[Alexo] recognition.onerror", event.error, { ignored: ignoreRecognitionEventsRef.current });
      if (ignoreRecognitionEventsRef.current || event.error === "no-speech") return;
      processOnEndRef.current = false;
      ignoreRecognitionEventsRef.current = true;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setErrorMessage("Permissão de microfone negada.");
      } else if (event.error === "network" || event.error === "aborted") {
        setErrorMessage("Reconhecimento de voz interrompido.");
      } else {
        setErrorMessage("Erro no reconhecimento de voz.");
      }
      discardSession();
      setState("ERROR");
      scheduleResultReset();
    };

    recognition.onend = () => {
      console.log("[Alexo] recognition.onend", {
        ignored: ignoreRecognitionEventsRef.current,
        processOnEnd: processOnEndRef.current,
        transcript: transcriptRef.current,
        deadlineReached: Date.now() >= deadline,
      });
      activeRecognitionRef.current = false;
      clearTimer(speechTimeoutRef);
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      if (ignoreRecognitionEventsRef.current) {
        ignoreRecognitionEventsRef.current = false;
        return;
      }
      const hasTranscript = Boolean(transcriptRef.current.trim());
      if (processOnEndRef.current && hasTranscript) {
        processOnEndRef.current = false;
        processUtterance(transcriptRef.current.trim());
      } else if (Date.now() < deadline) {
        console.log("[Alexo] reiniciando reconhecimento (sem fala final detectada)");
        window.setTimeout(() => void beginListeningRef.current(continuation, deadline, false), 100);
      } else if (hasTranscript) {
        console.warn("[Alexo] deadline atingido, processando transcript pendente", transcriptRef.current);
        processOnEndRef.current = false;
        processUtterance(transcriptRef.current.trim());
      } else {
        console.warn("[Alexo] deadline atingido sem fala detectada");
        if (continuation) {
          void sendDemand("cancel").catch(() => undefined);
          setResponseText("Conversa encerrada.");
          setResponseStatus("cancelled");
          setState("RESULT");
          scheduleResultReset();
        } else {
          returnToIdle();
        }
      }
    };

    try {
      activeRecognitionRef.current = true;
      recognition.start();
      console.log("[Alexo] recognition.start()", { continuation, deadlineInMs: deadline - Date.now() });
      speechTimeoutRef.current = setTimeout(() => {
        if (!activeRecognitionRef.current) return;
        console.warn("[Alexo] deadline timeout: parando reconhecimento", { continuation });
        processOnEndRef.current = false;
        recognition.stop();
        if (continuation) {
          void sendDemand("cancel").catch(() => undefined);
          setResponseText("Conversa encerrada.");
          setResponseStatus("cancelled");
          setState("RESULT");
          scheduleResultReset();
        } else {
          returnToIdle();
        }
      }, Math.max(0, deadline - Date.now()));
    } catch (error) {
      console.error("[Alexo] erro ao iniciar microfone", error);
      activeRecognitionRef.current = false;
      discardSession();
      setErrorMessage("Não foi possível iniciar o microfone.");
      setState("ERROR");
      scheduleResultReset();
    }
  }, [clearTimer, discardSession, processUtterance, returnToIdle, scheduleResultReset, sendDemand, stopWakeWord]);

  useEffect(() => {
    beginListeningRef.current = beginListening;
  }, [beginListening]);

  const startConversation = useCallback(async (bargeIn = false) => {
    clearTimer(resultTimeoutRef);
    clearTimer(postTtsTimeoutRef);
    if (state === "SPEAKING" && bargeIn && sessionIdRef.current) {
      window.speechSynthesis.cancel();
      await beginListening(true);
      return;
    }
    if (state !== "IDLE") return;
    sessionIdRef.current = crypto.randomUUID();
    conversationTimeoutRef.current = setTimeout(() => {
      void sendDemand("cancel").catch(() => undefined);
      returnToIdle();
    }, clientConfig.conversationMaxMs);
    await beginListening(false);
  }, [beginListening, clearTimer, returnToIdle, sendDemand, state]);

  const cancelConversation = useCallback(() => {
    const sessionId = sessionIdRef.current;
    stopRecognition(true);
    window.speechSynthesis.cancel();
    if (sessionId) void sendDemand("cancel").catch(() => undefined);
    returnToIdle();
  }, [returnToIdle, sendDemand, stopRecognition]);

  useEffect(() => {
    const handleWakeWord = () => void startConversation();
    window.addEventListener("alexo-wake-word", handleWakeWord);
    return () => window.removeEventListener("alexo-wake-word", handleWakeWord);
  }, [startConversation]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (state === "IDLE") void startWakeWord();
      else void stopWakeWord();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [startWakeWord, state, stopWakeWord]);

  useEffect(() => {
    void requestWakeLock();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void requestWakeLock();
      else if (state !== "IDLE") returnToIdle();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [requestWakeLock, returnToIdle, state]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      stopRecognition(true);
      window.speechSynthesis.cancel();
      void stopWakeWord();
      void releaseWakeLock();
      networkControllerRef.current?.abort();
      clearTimer(speechTimeoutRef);
      clearTimer(conversationTimeoutRef);
      clearTimer(resultTimeoutRef);
      clearTimer(postTtsTimeoutRef);
    };
  }, [clearTimer, releaseWakeLock, stopRecognition, stopWakeWord]);

  const activeConversation = state === "LISTENING" || state === "PROCESSING" || state === "SPEAKING";
  const statusConfig: Record<AppState, { label: string; color: string; textColor: string }> = {
    IDLE: { label: wakeWordStatus || "Toque para falar", color: "bg-zinc-800", textColor: "text-zinc-50" },
    LISTENING: { label: awaitingReply ? "Aguardando sua resposta..." : "Ouvindo...", color: "bg-blue-600", textColor: "text-white" },
    PROCESSING: { label: "Processando...", color: "bg-amber-500", textColor: "text-black" },
    SPEAKING: { label: "Alexo está falando...", color: "bg-violet-600", textColor: "text-white" },
    RESULT: { label: responseStatus === "cancelled" ? "Conversa encerrada" : "Concluído", color: responseStatus === "success" ? "bg-emerald-600" : "bg-zinc-700", textColor: "text-white" },
    ERROR: { label: "Erro", color: "bg-red-600", textColor: "text-white" },
  };
  const current = statusConfig[state];
  const slotKeys = Object.keys(slotLabels);

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <div className={`flex w-full max-w-4xl flex-col items-center gap-6 rounded-3xl px-8 py-10 text-center shadow-2xl transition-all duration-300 ${current.color} ${current.textColor}`}>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Alexo</h1>
        {isClient && !isSpeechSupported ? (
          <p className="text-2xl font-semibold">Seu navegador não suporta reconhecimento de voz.</p>
        ) : (
          <>
            <button
              onClick={() => void startConversation(state === "SPEAKING")}
              disabled={state === "LISTENING" || state === "PROCESSING"}
              className="flex h-40 w-40 items-center justify-center rounded-full bg-white/20 text-4xl font-bold backdrop-blur-sm transition-transform hover:scale-105 active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
            >
              {state === "SPEAKING" ? "Falar" : "Falar"}
            </button>
            <p className="text-2xl font-semibold sm:text-3xl">{current.label}</p>
            {state === "LISTENING" && responseText && <p className="max-w-2xl text-xl font-medium">{responseText}</p>}
            {state === "LISTENING" && recognizedText && <p className="text-xl opacity-90">{recognizedText}</p>}
            {lastUtterance && state !== "IDLE" && <p className="text-lg opacity-80">Você: {lastUtterance}</p>}
            {(state === "SPEAKING" || state === "RESULT") && responseText && <p className={`max-w-3xl text-2xl font-medium leading-relaxed ${responseStatus === "confirming" ? "rounded-2xl bg-white/20 p-5" : ""}`}>{responseText}</p>}
            {state === "ERROR" && <p className="text-xl font-medium">{errorMessage}</p>}
            {conversationData && state !== "IDLE" && (
              <div className="w-full max-w-2xl rounded-2xl bg-black/15 p-5 text-left text-lg">
                <p className="mb-3 text-center font-bold">Campos da demanda</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {slotKeys.map((key) => {
                    const value = conversationData.slots?.[key];
                    const missing = conversationData.missing?.includes(key) ?? !value;
                    return <p key={key} className={missing ? "opacity-60" : "font-medium"}>{missing ? "○" : "✓"} {slotLabels[key]}: {value || "—"}</p>;
                  })}
                </div>
              </div>
            )}
            {activeConversation && <button onClick={cancelConversation} className="rounded-xl border border-white/50 px-8 py-3 text-xl font-semibold transition-colors hover:bg-white/15">Cancelar</button>}
          </>
        )}
      </div>
    </div>
  );
}
