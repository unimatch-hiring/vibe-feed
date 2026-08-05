import { describe, it, expect } from "vitest";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";
import { mockSummarizer, WEBLLM_MODEL, WEBLLM_MODELS } from "./summarizer";

describe("mockSummarizer", () => {
  it("returns the first sentence of the text", async () => {
    const out = await mockSummarizer.summarize("First sentence. Second one.");
    expect(out).toBe("First sentence.");
  });

  it("strips HTML tags", async () => {
    const out = await mockSummarizer.summarize("<p>Hello <b>world</b>.</p> Next.");
    expect(out).toBe("Hello world.");
  });

  it("falls back to a placeholder for empty input", async () => {
    expect(await mockSummarizer.summarize("")).toBe("(no summary)");
  });
});

describe("WEBLLM_MODELS", () => {
  const catalog = new Map(
    prebuiltAppConfig.model_list.map((entry) => [entry.model_id, entry] as const)
  );

  // A typo'd model_id otherwise surfaces only at runtime, after the user has
  // already opted into a multi-hundred-MB download.
  it("only lists ids that exist in the MLC prebuilt catalog", () => {
    for (const model of WEBLLM_MODELS) {
      expect(catalog.has(model.id), `${model.id} missing from prebuilt catalog`).toBe(true);
    }
  });

  it("quotes the catalog's own vram figure, so the UI can't overpromise", () => {
    for (const model of WEBLLM_MODELS) {
      expect(Math.round(catalog.get(model.id)!.vram_required_MB!)).toBe(model.vramMb);
    }
  });

  it("defaults to the lightest model, so a first run can't fail on memory", () => {
    const lightest = Math.min(...WEBLLM_MODELS.map((m) => m.vramMb));
    expect(WEBLLM_MODEL).toBe(WEBLLM_MODELS[0].id);
    expect(catalog.get(WEBLLM_MODEL)!.vram_required_MB).toBeLessThanOrEqual(lightest + 100);
  });

  it("has no duplicate entries", () => {
    expect(new Set(WEBLLM_MODELS.map((m) => m.id)).size).toBe(WEBLLM_MODELS.length);
  });
});
