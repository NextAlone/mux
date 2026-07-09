const s = mux.schema;

export const meta = {
  name: "Fusion",
  description: "Run a selected multi-model panel in parallel and synthesize its conclusions.",
  argsSchema: s.object(
    {
      prompt: s.string({ minLength: 1 }),
      panel: s.array(
        s.object(
          {
            model: s.string({ minLength: 1 }),
            thinking: s.optional(s.enum(["off", "low", "medium", "high", "xhigh", "max"])),
          },
          { additionalProperties: false }
        ),
        { minItems: 2, maxItems: 8 }
      ),
      judge: s.object(
        {
          model: s.string({ minLength: 1 }),
          thinking: s.optional(s.enum(["off", "low", "medium", "high", "xhigh", "max"])),
        },
        { additionalProperties: false }
      ),
    },
    { additionalProperties: false }
  ),
};

export default function workflow({ args, phase, agent, parallel }) {
  const panel = uniquePanel(args.panel);
  if (panel.length < 2) {
    return {
      reportMarkdown: "Fusion needs at least two distinct model aliases or provider:model IDs.",
    };
  }

  const models = panel.map((entry) => entry.model);
  phase("panel", { models });
  const responses = parallel(
    panel.map(
      (entry, index) => () =>
        agent(panelPrompt(args.prompt), {
          id: "panel-" + index,
          title: "Panel: " + entry.model,
          // Independent panelists only gather evidence; parallel writes would make results order-dependent.
          agentId: "explore",
          model: entry.model,
          ...(entry.thinking ? { thinking: entry.thinking } : {}),
        })
    ),
    { maxParallel: models.length }
  );

  phase("synthesize", { responseCount: responses.length });
  const reportMarkdown = agent(synthesisPrompt(args.prompt, models, responses), {
    id: "synthesize",
    title: "Synthesize panel",
    agentId: "explore",
    model: args.judge.model,
    ...(args.judge.thinking ? { thinking: args.judge.thinking } : {}),
  });

  return {
    reportMarkdown,
    structuredOutput: {
      prompt: args.prompt,
      models,
      judgeModel: args.judge.model,
      responseCount: responses.length,
    },
  };
}

function uniquePanel(values) {
  const seen = {};
  const output = [];
  for (const value of values) {
    const model = String(value.model).trim();
    if (model && !seen[model]) {
      seen[model] = true;
      output.push({ model, ...(value.thinking ? { thinking: value.thinking } : {}) });
    }
  }
  return output;
}

function panelPrompt(prompt) {
  return [
    "Independently analyze the task below.",
    "Use read-only tools when evidence from the workspace is useful. Do not edit files.",
    "State assumptions, evidence, risks, and a concrete recommendation. Do not defer to other panelists.",
    "",
    "## Task",
    prompt,
  ].join("\n");
}

function synthesisPrompt(prompt, models, responses) {
  const panel = responses
    .map(
      (response, index) => "## " + models[index] + "\n\n" + mux.utils.compactText(response, 12000)
    )
    .join("\n\n");
  return [
    "Act as the judge for a multi-model panel. Synthesize; do not merely concatenate.",
    "Separate genuine agreement from repeated unsupported claims. Preserve material disagreement and attribute each stance to its model.",
    "Return concise Markdown with these sections: Consensus, Contradictions, Partial coverage, Unique insights, Blind spots, and Final recommendation.",
    "",
    "# Original task",
    prompt,
    "",
    "# Panel responses",
    panel,
  ].join("\n");
}
