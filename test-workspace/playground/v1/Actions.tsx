import {
  useCopilotAction,
  useCopilotAuthenticatedAction_c,
  useLangGraphInterrupt,
} from "@copilotkit/react-core";

export function Actions() {
  // V1 render: register a todo-creation action
  useCopilotAction({
    name: "addTodo",
    description: "Add a new todo item to the board",
    parameters: [{ name: "title", type: "string" }],
    handler: async () => {},
  });

  useCopilotAuthenticatedAction_c({
    name: "deleteUser",
    description: "Delete a user account (requires auth)",
    parameters: [],
    handler: async () => {},
  });

  useLangGraphInterrupt({
    render: ({ event, resolve }: { event: unknown; resolve: (v: string) => void }) => (
      <div>Interrupt: approve action?</div>
    ),
  });

  return <div>v1 actions</div>;
}
