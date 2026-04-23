const baseUrl = process.env.RAH_BASE_URL ?? "http://127.0.0.1:43111";

type PtyReplayFrame = {
  type: "pty.replay";
  sessionId: string;
  chunks: string[];
};

type PtyOutputFrame = {
  type: "pty.output";
  sessionId: string;
  data: string;
};

type PtyExitedFrame = {
  type: "pty.exited";
  sessionId: string;
  exitCode?: number;
  signal?: string;
};

type PtyServerFrame = PtyReplayFrame | PtyOutputFrame | PtyExitedFrame;

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${path}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

async function waitFor(check: () => boolean, transcript: () => string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for terminal state. Transcript tail: ${JSON.stringify(transcript().slice(-1200))}`);
}

async function main() {
  const created = await requestJson<{ terminal: { id: string; cwd: string; shell: string } }>("/api/terminal/start", {
    method: "POST",
    body: JSON.stringify({ cwd: "~", cols: 100, rows: 32 }),
  });

  const terminal = created.terminal;
  const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/pty/${terminal.id}`);
  let transcript = "";
  let sawExit = false;

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      ws.removeEventListener("open", onOpen);
      reject(new Error("Failed to open terminal PTY websocket."));
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });

  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as PtyServerFrame;
    if (frame.type === "pty.replay") {
      transcript += frame.chunks.join("");
      return;
    }
    if (frame.type === "pty.output") {
      transcript += frame.data;
      return;
    }
    if (frame.type === "pty.exited") {
      sawExit = true;
    }
  });

  const send = (payload: Record<string, unknown>) => {
    ws.send(JSON.stringify(payload));
  };

  send({
    type: "pty.input",
    sessionId: terminal.id,
    clientId: "terminal-smoke",
    data: "printf 'RAH_TERMINAL_SMOKE\\n'\r",
  });
  await waitFor(() => transcript.includes("RAH_TERMINAL_SMOKE"), () => transcript);

  send({
    type: "pty.resize",
    sessionId: terminal.id,
    clientId: "terminal-smoke",
    cols: 140,
    rows: 40,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  send({
    type: "pty.input",
    sessionId: terminal.id,
    clientId: "terminal-smoke",
    data: "stty size\r",
  });
  await waitFor(() => transcript.includes("40 140"), () => transcript);

  send({
    type: "pty.input",
    sessionId: terminal.id,
    clientId: "terminal-smoke",
    data: "pwd\r",
  });
  await waitFor(() => transcript.includes(terminal.cwd), () => transcript);

  await requestJson(`/api/terminal/${terminal.id}/close`, {
    method: "POST",
  });
  await waitFor(() => sawExit, () => transcript);
  ws.close();

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        terminalId: terminal.id,
        cwd: terminal.cwd,
        shell: terminal.shell,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
