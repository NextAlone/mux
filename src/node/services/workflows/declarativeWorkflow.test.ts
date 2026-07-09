import { describe, expect, test } from "bun:test";

import {
  compileDeclarativeWorkflow,
  DeclarativeWorkflowParseError,
  parseDeclarativeWorkflow,
} from "./declarativeWorkflow";
import { parseWorkflowMetadata } from "./workflowMetadata";

export const THREE_STAGE_WORKFLOW = `---
version: 1
name: three-stage-change
description: Analyze, implement, and verify a requested change.
inputs:
  request:
    description: Change to make
    required: true
steps:
  - id: analyze
    title: Analyze
    agent: explore
  - id: implement
    title: Implement
    agent: exec
    model: openai:gpt-test
    thinking: high
  - id: verify
    title: Verify
    agent: exec
result:
  report_markdown: |
    # Verification

    \${{ steps.verify.output }}
  structured_output:
    analysis: \${{ steps.analyze.output }}
---
Follow the repository instructions and cite concrete evidence.

## analyze
Analyze this request without editing files:

\${{ args.request }}

\`\`\`md
## implement
This fenced heading is prompt content, not a workflow step.
\`\`\`

Nested heading content
---

> ## quoted-heading
> This quoted heading is prompt content too.

## implement
Implement the request below in the current workspace.

Request: \${{ args.request }}

Analysis:
\${{ steps.analyze.output }}

## verify
Verify the implementation for \${{ args.request }}.

Implementation report:
\${{ steps.implement.output }}
`;

describe("declarative workflows", () => {
  test("parses Markdown step prompts and compiles static workflow metadata", () => {
    const parsed = parseDeclarativeWorkflow(THREE_STAGE_WORKFLOW);

    expect(parsed.instructions).toBe(
      "Follow the repository instructions and cite concrete evidence."
    );
    expect(parsed.stepPrompts.analyze).toContain("${{ args.request }}");
    expect(parsed.stepPrompts.analyze).toContain("This fenced heading");
    expect(parsed.stepPrompts.analyze).toContain("This quoted heading");
    expect(parsed.frontmatter.steps.map((step) => step.isolation)).toEqual([
      "none",
      "none",
      "none",
    ]);

    const compiled = compileDeclarativeWorkflow(THREE_STAGE_WORKFLOW);
    expect(parseWorkflowMetadata(compiled)).toMatchObject({
      name: "three-stage-change",
      description: "Analyze, implement, and verify a requested change.",
      argsSchema: {
        required: ["request"],
        properties: { request: { type: "string" } },
      },
    });
    expect(compiled).toContain("renderValue");
    expect(compileDeclarativeWorkflow(THREE_STAGE_WORKFLOW)).toBe(compiled);
  });

  test("rejects invalid sections, schemas, and references before execution", () => {
    expect(() =>
      parseDeclarativeWorkflow(`---
version: 1
name: duplicate
description: Broken workflow
steps:
  - id: repeated
  - id: repeated
result:
  report_markdown: done
---
## repeated
First
## repeated
Second`)
    ).toThrow("Duplicate workflow step id");

    expect(() =>
      parseDeclarativeWorkflow(`---
version: 1
name: wrong-order
description: Wrong section order
steps:
  - id: analyze
  - id: verify
result:
  report_markdown: done
---
## verify
Verify
## analyze
Analyze`)
    ).toThrow("must appear once and in declared order");

    expect(() =>
      parseDeclarativeWorkflow(`---
version: 1
name: forward-reference
description: Invalid forward reference
steps:
  - id: analyze
  - id: verify
result:
  report_markdown: done
---
## analyze
Use \${{ steps.verify.output }}
## verify
Verify`)
    ).toThrow("Unknown or forward workflow step reference");

    expect(() =>
      parseDeclarativeWorkflow(`---
version: 1
name: unsafe-reference
description: Invalid reference
inputs:
  request: {}
steps:
  - id: analyze
result:
  report_markdown: done
---
## analyze
Use \${{ args.__proto__ }}`)
    ).toThrow("Unsafe or malformed workflow template reference");

    expect(() =>
      parseDeclarativeWorkflow(`---
version: 1
name: unsafe-key
description: Invalid result key
steps:
  - id: analyze
result:
  report_markdown: done
  structured_output:
    constructor: blocked
---
## analyze
Analyze`)
    ).toThrow("Unsafe declarative workflow key");

    expect(() =>
      parseDeclarativeWorkflow(`---
version: 1
name: invalid-schema
description: Invalid output
steps:
  - id: analyze
    schema:
      type: string
result:
  report_markdown: done
---
## analyze
Analyze`)
    ).toThrow(DeclarativeWorkflowParseError);

    expect(() =>
      parseDeclarativeWorkflow(`---
version: 1
name: invalid-default
description: Invalid input default
inputs:
  count:
    type: integer
    default: nope
steps:
  - id: analyze
result:
  report_markdown: done
---
## analyze
Analyze`)
    ).toThrow("Invalid default for workflow input count");

    expect(() =>
      parseDeclarativeWorkflow(`---
version: 1
name: invalid-enum
description: Invalid input enum
inputs:
  count:
    type: number
    enum: [one, two]
steps:
  - id: analyze
result:
  report_markdown: done
---
## analyze
Analyze`)
    ).toThrow("Invalid enum[0] for workflow input count");

    expect(() =>
      parseDeclarativeWorkflow(`---
version: 1
name: cyclic-result
description: Cyclic result data
steps:
  - id: analyze
result:
  report_markdown: done
  structured_output: &result
    self: *result
---
## analyze
Analyze`)
    ).toThrow("must not be cyclic");
  });

  test("does not treat an indented YAML block line as the frontmatter delimiter", () => {
    const workflow = THREE_STAGE_WORKFLOW.replace(
      "    # Verification\n\n    ${{ steps.verify.output }}",
      "    ---\n    # Verification\n\n    ${{ steps.verify.output }}"
    );

    expect(parseDeclarativeWorkflow(workflow).frontmatter.result.report_markdown).toStartWith(
      "---\n# Verification"
    );
  });
});
