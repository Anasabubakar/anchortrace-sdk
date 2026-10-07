import { z } from "zod";
import { caseSchema } from "./input.ts";
import { evidenceFileSchema } from "./evidence.ts";
import { reportSchema } from "./reportSchema.ts";

export const SCHEMA_TARGETS: Array<{ name: "report" | "evidence" | "case"; path: string; title: string; schema: z.ZodType }> = [
  { name: "report", path: "schema/report.v1.schema.json", title: "AnchorTrace report v1", schema: reportSchema },
  { name: "evidence", path: "schema/evidence.v1.schema.json", title: "AnchorTrace evidence file v1", schema: evidenceFileSchema },
  { name: "case", path: "schema/case.v1.schema.json", title: "AnchorTrace case file v1", schema: caseSchema },
];

export function jsonSchemaFor(schema: z.ZodType, title: string): Record<string, unknown> {
  return { title, ...z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) };
}
