import { Effect } from "effect";
import * as Schema from "effect/Schema";
import type { Input, Output, Processor } from "./types.js";

export type ComponentKind = "input" | "processor" | "output";

export interface ComponentBuildContext {
  readonly buildProcessor: (
    config: Record<string, unknown>,
  ) => Effect.Effect<Processor<any>, unknown>;
}

export interface ComponentDefinition<Config, Component> {
  readonly name: string;
  readonly schema: Schema.Schema<Config, unknown, never>;
  readonly build: (
    config: Config,
    context: ComponentBuildContext,
  ) => Effect.Effect<Component, unknown, never>;
}

type AnyInputDefinition = ComponentDefinition<any, Input<any>>;
type AnyProcessorDefinition = ComponentDefinition<any, Processor<any>>;
type AnyOutputDefinition = ComponentDefinition<any, Output<any>>;

export class ComponentRegistrationError extends Error {
  readonly _tag = "ComponentRegistrationError";

  constructor(message: string) {
    super(message);
    this.name = "ComponentRegistrationError";
  }
}

export class ComponentRegistry {
  private readonly inputs = new Map<string, AnyInputDefinition>();
  private readonly processors = new Map<string, AnyProcessorDefinition>();
  private readonly outputs = new Map<string, AnyOutputDefinition>();

  registerInput<Config>(
    definition: ComponentDefinition<Config, Input<any>>,
  ): this {
    this.register("input", this.inputs, definition);
    return this;
  }

  registerProcessor<Config>(
    definition: ComponentDefinition<Config, Processor<any>>,
  ): this {
    this.register("processor", this.processors, definition);
    return this;
  }

  registerOutput<Config>(
    definition: ComponentDefinition<Config, Output<any>>,
  ): this {
    this.register("output", this.outputs, definition);
    return this;
  }

  getInput(name: string): AnyInputDefinition | undefined {
    return this.inputs.get(name);
  }

  getProcessor(name: string): AnyProcessorDefinition | undefined {
    return this.processors.get(name);
  }

  getOutput(name: string): AnyOutputDefinition | undefined {
    return this.outputs.get(name);
  }

  getSchemas(kind: ComponentKind): Readonly<Record<string, Schema.Schema.Any>> {
    const definitions = this.getDefinitions(kind);
    return Object.fromEntries(
      [...definitions].map(([name, definition]) => [name, definition.schema]),
    );
  }

  assertNoConflicts(
    kind: ComponentKind,
    reservedNames: ReadonlySet<string>,
  ): void {
    for (const name of this.getDefinitions(kind).keys()) {
      if (reservedNames.has(name)) {
        throw new ComponentRegistrationError(
          `Cannot register ${kind} component '${name}': the name is reserved by a built-in component`,
        );
      }
    }
  }

  private getDefinitions(
    kind: ComponentKind,
  ):
    | Map<string, AnyInputDefinition>
    | Map<string, AnyProcessorDefinition>
    | Map<string, AnyOutputDefinition> {
    switch (kind) {
      case "input":
        return this.inputs;
      case "processor":
        return this.processors;
      case "output":
        return this.outputs;
    }
  }

  private register<Component>(
    kind: ComponentKind,
    definitions: Map<string, Component>,
    definition: Component,
  ): void {
    const name = (definition as { readonly name: string }).name.trim();
    if (name.length === 0) {
      throw new ComponentRegistrationError(
        `Cannot register ${kind} component with an empty name`,
      );
    }
    if (definitions.has(name)) {
      throw new ComponentRegistrationError(
        `${kind[0].toUpperCase()}${kind.slice(1)} component '${name}' is already registered`,
      );
    }
    definitions.set(name, definition);
  }
}

export const createComponentRegistry = (): ComponentRegistry =>
  new ComponentRegistry();
