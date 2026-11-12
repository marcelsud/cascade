import { Cause, Context, Effect, Stream } from "effect";

// Run-local stop check. Standalone inputs continue polling until closed.
// Check the signal directly: a watcher fiber may not run before the next pull.
export const IntakeStopRequested = Context.Reference<Effect.Effect<boolean>>(
  "cascade/IntakeStopRequested",
  { defaultValue: () => Effect.succeed(false) },
);

export const stopBeforeNextPull = <A, E, R>(
  pull: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Cause.Done, R> =>
  Effect.flatMap(IntakeStopRequested, (check) =>
    Effect.flatMap(
      check,
      (stop): Effect.Effect<A, E | Cause.Done, R> =>
        stop ? Cause.done() : pull,
    ),
  );

export const haltBeforeNextPull = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> =>
  Stream.transformPull(stream, (pull) =>
    Effect.succeed(stopBeforeNextPull(pull)),
  );
