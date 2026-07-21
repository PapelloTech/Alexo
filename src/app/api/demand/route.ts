import { NextResponse } from "next/server";

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const ALEXO_SHARED_SECRET = process.env.ALEXO_SHARED_SECRET;

interface DemandRequest {
  text: string;
  timestamp?: string;
  sessionId?: string;
}

export async function POST(request: Request) {
  if (!N8N_WEBHOOK_URL) {
    return NextResponse.json(
      { speech: "Configuração do servidor incompleta.", status: "error" },
      { status: 500 }
    );
  }

  if (!ALEXO_SHARED_SECRET) {
    return NextResponse.json(
      { speech: "Segredo de autenticação não configurado.", status: "error" },
      { status: 500 }
    );
  }

  let body: DemandRequest;
  try {
    body = (await request.json()) as DemandRequest;
  } catch {
    return NextResponse.json(
      { speech: "Corpo da requisição inválido.", status: "error" },
      { status: 400 }
    );
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json(
      { speech: "Nenhum texto foi enviado.", status: "error" },
      { status: 400 }
    );
  }

  const payload = {
    text,
    timestamp: body.timestamp || new Date().toISOString(),
    sessionId: body.sessionId || crypto.randomUUID(),
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const n8nResponse = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-alexo-auth": ALEXO_SHARED_SECRET,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!n8nResponse.ok) {
      const errorText = await n8nResponse.text().catch(() => "Resposta inválida do n8n");
      console.error("n8n error:", n8nResponse.status, errorText);
      return NextResponse.json(
        { speech: "Não consegui completar a solicitação.", status: "error" },
        { status: 502 }
      );
    }

    const data = (await n8nResponse.json()) as {
      speech?: string;
      status?: string;
      action?: string;
      data?: unknown;
    };

    if (!data.speech) {
      return NextResponse.json(
        { speech: "Resposta do assistente não contém frase.", status: "error" },
        { status: 502 }
      );
    }

    return NextResponse.json({
      speech: data.speech,
      status: data.status || "success",
      action: data.action,
      data: data.data,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    console.error("Proxy error:", error);

    const message = error instanceof Error && error.name === "AbortError"
      ? "Tempo esgotado ao processar a solicitação."
      : "Erro de comunicação com o assistente.";

    return NextResponse.json(
      { speech: message, status: "error" },
      { status: 504 }
    );
  }
}
