// Request validation for the eval HTTP API. Regex outcome checks (`matches`)
// are deliberately not accepted over HTTP: user-supplied regexes can be made
// to backtrack catastrophically and stall the single-process public demo.
// They remain available in the library and the offline `eval:trace` CLI.
import { z } from 'zod';
import type { TrajectorySpec } from './trajectory.js';

const argMatch = z.enum(['exact', 'subset', 'ignore']);
const text = z.string().max(500);

export const specSchema = z
  .object({
    expected: z
      .array(
        z
          .object({
            tool: z.string().min(1).max(200),
            args: z.record(z.unknown()).optional(),
            argMatch: argMatch.optional(),
          })
          .strict(),
      )
      .max(200),
    match: z.enum(['exact', 'in_order', 'any_order']).optional(),
    argMatch: argMatch.optional(),
    forbiddenTools: z.array(z.string().max(200)).max(50).optional(),
    maxSteps: z.number().int().nonnegative().optional(),
    maxToolCalls: z.number().int().nonnegative().optional(),
    outcome: z
      .object({
        mustContain: z.array(text).max(50).optional(),
        mustNotContain: z.array(text).max(50).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function parseSpec(input: unknown): TrajectorySpec | undefined {
  if (input === undefined || input === null) return undefined;
  return specSchema.parse(input) as TrajectorySpec;
}
