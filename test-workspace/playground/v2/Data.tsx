import { useCopilotReadable } from "@copilotkit/react-core";

export function Data() {
  useCopilotReadable({
    description: "current user preferences",
    value: { theme: "dark", units: "imperial", locale: "en-US" },
  });

  return <div>v2 data</div>;
}
