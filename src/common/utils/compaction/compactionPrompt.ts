import {
  DEFAULT_COMPACTION_WORD_TARGET,
  WORDS_TO_TOKENS_RATIO,
  buildCompactionPrompt,
} from "@/common/constants/ui";
import { isDefaultSourceContent } from "@/common/types/message";
import type { CompactionRequestData } from "@/common/types/message";
import type { LocalCompactionStrategy } from "./strategyConfig";

interface BuildCompactionMessageTextOptions {
  maxOutputTokens?: number;
  followUpContent?: CompactionRequestData["followUpContent"];
}

interface BuildLocalStrategyCompactionMessageTextOptions extends BuildCompactionMessageTextOptions {
  localStrategy: LocalCompactionStrategy;
}

/**
 * Build the compaction prompt text sent to the model.
 *
 * This is shared by frontend-triggered and backend-triggered compaction flows
 * so prompt wording stays consistent regardless of where compaction starts.
 */
export function buildCompactionMessageText(options: BuildCompactionMessageTextOptions): string {
  const targetWords = options.maxOutputTokens
    ? Math.round(options.maxOutputTokens / WORDS_TO_TOKENS_RATIO)
    : DEFAULT_COMPACTION_WORD_TARGET;

  let messageText = buildCompactionPrompt(targetWords);

  if (options.followUpContent && !isDefaultSourceContent(options.followUpContent)) {
    messageText += `\n\nThe user wants to continue with: ${options.followUpContent.text}`;
  }

  return messageText;
}

function appendFollowUpText(
  messageText: string,
  followUpContent: CompactionRequestData["followUpContent"] | undefined
): string {
  if (followUpContent && !isDefaultSourceContent(followUpContent)) {
    return `${messageText}\n\nThe user wants to continue with: ${followUpContent.text}`;
  }

  return messageText;
}

function buildPiLocalCompactionPrompt(targetWords: number): string {
  return `Write a dense handoff summary of the older conversation context.

Target length: about ${targetWords} words.

Recent messages are preserved verbatim outside this summary. Do not restate them unless they are needed to explain older context.

Include only durable facts needed for continuation: user goal, constraints, decisions, files/APIs touched, current state, known errors, and unresolved blockers. Use compact prose. Do not add next-step suggestions or filler.`;
}

function buildHybridLocalCompactionPrompt(targetWords: number): string {
  return `Write a compact handoff for the next assistant.

Target: about ${targetWords} words.

Recent messages are preserved verbatim, so summarize only older context. Keep user goal, active task, constraints, decisions, file/API names, completed work, current state, errors, and blockers. Prefer terse factual bullets or dense prose. No suggestions, greetings, or repeated recent text.`;
}

export function buildLocalStrategyCompactionMessageText(
  options: BuildLocalStrategyCompactionMessageTextOptions
): string {
  if (options.localStrategy === "mux-current") {
    return buildCompactionMessageText(options);
  }

  const targetWords = options.maxOutputTokens
    ? Math.round(options.maxOutputTokens / WORDS_TO_TOKENS_RATIO)
    : DEFAULT_COMPACTION_WORD_TARGET;
  const prompt =
    options.localStrategy === "hybrid-local"
      ? buildHybridLocalCompactionPrompt(targetWords)
      : buildPiLocalCompactionPrompt(targetWords);

  return appendFollowUpText(prompt, options.followUpContent);
}
