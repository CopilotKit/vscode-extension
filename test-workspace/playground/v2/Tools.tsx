import { useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";

export function Tools() {
  useFrontendTool({
    name: "displayCurrentWeather",
    description: "Display current weather for a city",
    parameters: z.object({ city: z.string() }),
    handler: async ({ city }: { city: string }) => ({ city, temp: 72, unit: "F" }),
    render: (props: Record<string, unknown>) => {
      const args = (props.args ?? {}) as Record<string, unknown>;
      const result = (props.result ?? {}) as Record<string, unknown> | undefined;
      return (
        <div>
          Weather for {String(args.city ?? "...")}: {String(result?.temp ?? "loading")}°
          {String(result?.unit ?? "")}
        </div>
      );
    },
  });

  return <div>v2 tools</div>;
}
