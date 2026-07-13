# Graceful shutdown

Cascade drains pipelines when the CLI receives `SIGINT` or `SIGTERM`. The first
signal stops input consumption, waits for messages already being processed to
finish output delivery and acknowledgement, and then closes the input and
output. This preserves deferred acknowledgements such as SQS receipt deletion.

```yaml
shutdown_timeout_ms: 10000

input:
  # ...
output:
  # ...
```

`shutdown_timeout_ms` is a positive integer and defaults to 10 seconds. It
limits both the graceful drain and resource closing. Cascade exits non-zero if
the deadline expires. A second `SIGINT` or `SIGTERM` forces shutdown immediately
and also exits non-zero; in-progress delivery may then be retried by the input.

Library users can create a controller with `makeShutdownController()`, pass it
to `run`, and execute `controller.request` or `controller.requestForce` from
their host application's lifecycle hooks. A force request also requests that
input consumption stop, so `requestForce` is safe to call without a preceding
`request`.
