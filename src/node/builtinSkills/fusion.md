---
name: fusion
description: "[Workflow] Ask multiple selected models in parallel, then synthesize their agreement, disagreements, and strongest answer."
---

# Fusion

Use this workflow when the user wants multiple models to independently analyze the same prompt and combine their answers. It is most useful for architecture, debugging, reviews, research, and other decisions where model disagreement is valuable. Skip it for routine edits where the extra latency and cost do not help.

Fusion requires saved defaults in **Settings > Fusion**: at least two panel models and one judge. If it is not configured, tell the user to configure it; temporary model names do not bypass that requirement.

Interpret explicit natural-language model choices as one-shot overrides:

- "使用 mimo、gemini 来评审" replaces the panel for this run.
- "再加 kimi" appends a model for this run.
- "mimo、gemini 评审，gpt 汇总" replaces the panel and judge for this run.

These overrides never update saved configuration. Resolve familiar model names to a known alias or configured `provider:model` ID when calling the tool. If the user does not name temporary models, omit both override fields.

Invoke with:

```js
fusion({
  prompt: "<question or task>",
  panelOverride: {
    mode: "replace",
    models: ["<temporary model 1>", "<temporary model 2>"],
  },
  judgeOverride: { model: "<temporary judge>" },
});
```

The panel runs read-only so parallel models cannot clobber the workspace. The configured or temporary judge receives every panel response and returns one report that preserves consensus, contradictions, unique insights, blind spots, and a final recommendation.
