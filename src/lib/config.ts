function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const clientConfig = {
  initialSpeechTimeoutMs: readPositiveInteger(
    process.env.NEXT_PUBLIC_INITIAL_SPEECH_TIMEOUT_MS,
    10_000
  ),
  replyTimeoutMs: readPositiveInteger(
    process.env.NEXT_PUBLIC_REPLY_TIMEOUT_MS,
    15_000
  ),
  networkTimeoutMs: readPositiveInteger(
    process.env.NEXT_PUBLIC_NETWORK_TIMEOUT_MS,
    15_000
  ),
  conversationMaxMs: readPositiveInteger(
    process.env.NEXT_PUBLIC_CONVERSATION_MAX_MS,
    180_000
  ),
  postTtsDelayMs: readPositiveInteger(
    process.env.NEXT_PUBLIC_POST_TTS_DELAY_MS,
    300
  ),
  resultDisplayMs: readPositiveInteger(
    process.env.NEXT_PUBLIC_RESULT_DISPLAY_MS,
    4_000
  ),
  wakeWordEnabled: process.env.NEXT_PUBLIC_WAKE_WORD_ENABLED === "true",
  picovoiceAccessKey: process.env.NEXT_PUBLIC_PICOVOICE_ACCESS_KEY ?? "",
  picovoiceKeywordPath: process.env.NEXT_PUBLIC_PICOVOICE_KEYWORD_PATH ?? "",
};
