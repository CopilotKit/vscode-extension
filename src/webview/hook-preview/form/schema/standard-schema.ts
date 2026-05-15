import { zodToJsonSchema } from "zod-to-json-schema";
import { jsonSchemaToFormSchema, type JSONSchemaNode } from "./json-schema";
import type { FormSchema } from "./types";

interface StandardSchemaLike {
  "~standard"?: { vendor?: string; version?: number };
  /** Zod 4+ exposes a native toJSONSchema() method on schema objects. */
  toJSONSchema?: () => Record<string, unknown>;
}

export function standardSchemaToFormSchema(schema: unknown): FormSchema {
  const s = schema as StandardSchemaLike | undefined;
  const vendor = s?.["~standard"]?.vendor;

  if (vendor === "zod") {
    try {
      // Zod 4+ has a native toJSONSchema(); prefer it over zod-to-json-schema
      // which doesn't fully support Zod 4's internal schema representation.
      const json = (
        typeof s?.toJSONSchema === "function"
          ? s.toJSONSchema()
          : zodToJsonSchema(
              schema as Parameters<typeof zodToJsonSchema>[0],
            )
      ) as JSONSchemaNode;
      return jsonSchemaToFormSchema(json);
    } catch (err) {
      return {
        fields: [
          {
            kind: "raw-json",
            name: "$args",
            label: "args",
            required: true,
            hint: `Could not convert Zod schema: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  }

  return {
    fields: [
      {
        kind: "raw-json",
        name: "$args",
        label: "args",
        required: true,
        hint: vendor
          ? `Auto-form requires Zod; this schema is "${vendor}".`
          : "No schema metadata; edit as raw JSON.",
      },
    ],
  };
}
