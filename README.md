# usage-aware

A Claude Code mod that lets a session see how much of the plan's usage is left and when it resets, and steer by it.

It reads the figures the engine already has (`$.session.usage()` and the `session.measure` event: the 5-hour and 7-day windows, percent used, reset time, and the session's cost), so nothing extra is spawned or polled.

- **Status line:** `5h 32% ↻2h05m · 7d 41% ↻3d7h · $3.21`
- **A `usage` tool** the model calls: `read`, `resume_after_reset` (with a continuation prompt), `cancel_resume`, `allow_agents`.
- **Every prompt** carries the figures to the model as context the user does not see.
- **Thresholds** on the fuller window: past 75% the model is told once to stop fanning out; past 90% new `Agent` and `Workflow` calls are refused until the user says yes.
- **Resume:** a continuation prompt is submitted about 90 seconds after the window resets, armed by the model when it parks, or automatically when a main-loop turn dies at 98% or more. It only fires while the session stays open.

The thresholds are constants at the top of `hooks/register.ts`.

## Install

At the prompt of a terminal session:

```
/plugin install usage-aware --marketplace runa-tic/usage-aware
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install usage-aware --marketplace runa-tic/usage-aware
```

## Develop

```
claude plugin validate .
claude plugin test .
```

## License

MIT, see `LICENSE`.

