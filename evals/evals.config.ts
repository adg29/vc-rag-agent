import { defineEvalConfig } from "eve/evals";
import { createAnthropic } from "@ai-sdk/anthropic";

const openrouter = createAnthropic({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY!,
});

export default defineEvalConfig({
  judge: {
    model: openrouter("claude-haiku-4.5"),
  },
});
