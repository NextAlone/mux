const s = mux.schema;

export const meta = {
  name: "Fusion",
  description: "Run a selected multi-model panel in parallel and synthesize its conclusions.",
  argsSchema: s.object(
    {
      prompt: s.string({ minLength: 1 }),
      models: s.array(s.string({ minLength: 1 }), { minItems: 2, maxItems: 8 }),
      judgeModel: s.optional(s.string({ minLength: 1 })),
      thinking: s.optional(s.enum(["off", "low", "medium", "high", "xhigh", "max"])),
    },
    { additionalProperties: false }
  ),
};

export default function workflow({ args, phase, agent, parallel }) {
  const models = uniqueStrings(args.models);
  if (models.length < 2) {
    return {
      reportMarkdown: "Fusion needs at least two distinct model aliases or provider:model IDs.",
    };
  }

  phase("panel", { models });
  const responses = parallel(
    models.map(
      (model, index) => () =>
        agent(panelPrompt(args.prompt), {
          id: "panel-" + index,
          title: "Panel: " + model,
          // Independent panelists only gather evidence; parallel writes would make results order-dependent.
          agentId: "explore",
          model,
          ...(args.thinking ? { thinking: args.thinking } : {}),
        })
    ),
    { maxParallel: models.length }
  );

  phase("synthesize", { responseCount: responses.length });
  const reportMarkdown = agent(synthesisPrompt(args.prompt, models, responses), {
    id: "synthesize",
    title: "Synthesize panel",
    agentId: "explore",
    ...(args.judgeModel ? { model: args.judgeModel } : {}),
    ...(args.thinking ? { thinking: args.thinking } : {}),
  });

  return {
    reportMarkdown,
    structuredOutput: {
      prompt: args.prompt,
      models,
      judgeModel: args.judgeModel || null,
      responseCount: responses.length,
    },
  };
}

function uniqueStrings(values) {
  const seen = {};
  const output = [];
  for (const value of values) {
    const normalized = String(value).trim();
    if (normalized && !seen[normalized]) {
      seen[normalized] = true;
      output.push(normalized);
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
