---
name: fusion
description: "[Workflow] Ask multiple selected models in parallel, then synthesize their agreement, disagreements, and strongest answer."
---

# Fusion

Use this workflow when the user wants multiple models to independently analyze the same prompt and combine their answers. It is most useful for architecture, debugging, reviews, research, and other decisions where model disagreement is valuable. Skip it for routine edits where the extra latency and cost do not help.

The user must choose at least two model aliases or full `provider:model` strings. Do not guess which providers are configured. If models are missing, ask one concise question before invoking the workflow.

Invoke with:

```js
workflow_run({
  script_path: "skill://fusion/workflow.js",
  args: {
    prompt: "<question or task>",
    models: ["<model 1>", "<model 2>"],
    judgeModel: "<optional judge model>",
  },
});
```

The panel runs read-only so parallel models cannot clobber the workspace. The judge receives every panel response and returns one report that preserves consensus, contradictions, unique insights, blind spots, and a final recommendation. Omit `judgeModel` to use the workflow's inherited model.
