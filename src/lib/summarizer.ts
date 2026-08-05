// The feed's LLM layer. Any summarization / ranking goes through this narrow
// interface, so any implementation (mock / WebLLM / remote call) can hide
// behind it without touching the UI.
//
// The default is a mock summarizer — deterministic, instant, always works. A
// real in-browser model (WebLLM/WebGPU) is heavy (hundreds of MB to GB of
// weights) and isn't available on every machine, so the app must stay useful
// when WebGPU is absent.

export interface Summarizer {
  // Short summary of a single piece of text.
  summarize(text: string): Promise<string>;
}

// --- Mock: the default. Deterministic, instant, always works. ---
export const mockSummarizer: Summarizer = {
  async summarize(text: string): Promise<string> {
    const clean = text.replace(/<[^>]*>/g, "").trim();
    const firstSentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
    return firstSentence.slice(0, 200) || "(no summary)";
  },
};

// --- WebGPU availability check. ---
export function isWebGPUAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

// --- Rough memory budget hints, to gauge whether a model would fit. ---
// Both are best-effort and Chromium-only-ish:
//   deviceMemoryGb  — approximate device RAM (navigator.deviceMemory), capped by
//                     the browser (usually 0.25–8). undefined if unsupported.
//   usedJsHeapMb    — current JS heap usage (performance.memory). undefined if
//                     unsupported (non-Chromium).
export interface MemoryInfo {
  deviceMemoryGb?: number;
  usedJsHeapMb?: number;
}

export function getMemoryInfo(): MemoryInfo {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number };
  };
  return {
    deviceMemoryGb: nav.deviceMemory,
    usedJsHeapMb: perf.memory
      ? Math.round(perf.memory.usedJSHeapSize / 1048576)
      : undefined,
  };
}

// --- Optional: a real in-browser LLM via WebLLM. ---
// Opt-in only: the weights are ~300 MB, so nothing here runs unless the user
// asks for it. @mlc-ai/web-llm is an optionalDependency and the import below is
// dynamic on purpose — a machine without the package still type-checks, builds
// and runs on the mock summarizer.

export type EngineStatus = "idle" | "loading" | "ready" | "error" | "unsupported";

export interface OnDeviceModel {
  // MLC prebuilt model_id — must match @mlc-ai/web-llm's catalog exactly.
  id: string;
  label: string;
  // MLC's own vram_required_MB for the model, i.e. what the GPU must hold. The
  // download is roughly the same, and it is cached after the first run.
  vramMb: number;
  note: string;
}

// A curated slice of MLC's prebuilt catalog (163 entries, nearly all irrelevant
// here): instruct-tuned, q4f16_1, spanning "runs on anything" to "wants a real
// GPU". Ordered by weight, which is the only hard number available — public
// leaderboards (llm-stats.com and friends) rank frontier models and don't carry
// the sub-4B tier at all, so the notes are qualitative on purpose.
export const WEBLLM_MODELS: OnDeviceModel[] = [
  {
    id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    label: "Qwen2.5 0.5B",
    vramMb: 945,
    note: "fastest to load, roughest prose",
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 1B",
    vramMb: 879,
    note: "same footprint, steadier sentences",
  },
  {
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    label: "Qwen2.5 1.5B",
    vramMb: 1630,
    note: "noticeably fewer dropped facts",
  },
  {
    id: "gemma-2-2b-it-q4f16_1-MLC",
    label: "Gemma 2 2B",
    vramMb: 1895,
    note: "verbose but fluent",
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 3B",
    vramMb: 2264,
    note: "best summaries per MB",
  },
  {
    id: "Qwen2.5-7B-Instruct-q4f16_1-MLC",
    label: "Qwen2.5 7B",
    vramMb: 5107,
    note: "best quality, ~5 GB download",
  },
];

// Default stays the smallest: it is the one that loads on any WebGPU machine, so
// the first run can't fail on memory. Anything better is one pick away.
export const WEBLLM_MODEL = WEBLLM_MODELS[0].id;

// Cap so a long article can't blow past the model's small context window.
const MAX_INPUT_CHARS = 1500;

export async function createWebLLMSummarizer(
  onProgress?: (pct: number, text: string) => void,
  modelId: string = WEBLLM_MODEL
): Promise<Summarizer> {
  if (!isWebGPUAvailable()) {
    throw new Error(
      "WebGPU is not available in this browser — the on-device model can't run. The mock summarizer stays in use."
    );
  }

  const webllm = await import("@mlc-ai/web-llm");

  const engine = await webllm.CreateMLCEngine(modelId, {
    initProgressCallback: (report) => {
      // report.progress is 0..1
      onProgress?.(Math.round(report.progress * 100), report.text);
    },
  });

  return {
    async summarize(text: string): Promise<string> {
      const clean = text.replace(/<[^>]*>/g, "").trim().slice(0, MAX_INPUT_CHARS);
      if (!clean) return "(no summary)";

      try {
        const reply = await engine.chat.completions.create({
          messages: [
            {
              role: "system",
              content:
                "You summarize news articles. Answer with one or two plain sentences, no preamble, no bullet points.",
            },
            { role: "user", content: `Summarize:\n\n${clean}` },
          ],
          temperature: 0.3,
          max_tokens: 160,
        });
        return (reply.choices[0]?.message?.content ?? "").trim() || "(no summary)";
      } catch (err) {
        throw new Error(
          `WebLLM summarization failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
  };
}
