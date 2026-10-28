# mind-stack

A Claude Code mod that keeps the topic stack of the conversation on a line under the prompt, so the task you started with stays in sight while you chase side issues.

```
> _
  ? for shortcuts
  📚 fio bench → lease wait → hook fix
```

Each prompt you type is classified by one small `haiku` call, off the prompt's path (the turn never waits for it). Background task notifications, scheduled prompts and messages from other sessions are not judged:

| verdict | meaning | stack |
| --- | --- | --- |
| `same` | a follow-up, correction or answer about what the last reply was working on | unchanged |
| `push` | a sub-problem of the current topic | label pushed |
| `pop` | back to an earlier topic | topics above it are closed |
| `sibling` | the current side topic is done; a new sub-problem of an earlier topic | topics above that one are closed, label pushed |
| `switch` | unrelated new work | the root stays and the new topic goes under it; a second switch with no return to the root in between makes the first switch's topic the root |

Prompts shorter than 10 characters and slash commands are not classified. When the line is too narrow, the middle gives way and the root and the current topic stay: `fio bench → … → hook fix (6)`.

## Install

At the prompt of a terminal session:

```
/plugin install mind-stack --marketplace Daejun/mind-stack
```

From a shell:

```
claude plugin install mind-stack --marketplace Daejun/mind-stack
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Daejun/mind-stack`, then Add plugin.

## Commands

| command | does |
| --- | --- |
| `/topic` or `/topic log` | show the stack, closed side topics, and the haiku calls and tokens spent so far |
| `/topic push <label>` | push a topic by hand |
| `/topic pop [n]` | go up one level, or back to item `n` |
| `/topic rename <label>` | rename the current topic |
| `/topic reset` | empty the stack |
| `/topic off` / `/topic on` | turn automatic classification off or on |

The prompt right after a manual edit is not classified, so the edit stands. With automatic classification off, the line ends in `(manual)`.

## Settings

`/config` has one row for the mod, Icon: the mark drawn before the trail (📚 🥞 🍡 🪆 🧠 🐾, or none).

## Cost

One `haiku` call per prompt, effort `low`, with no conversation history: the stack labels, the last 400 characters of the previous reply and the first 600 characters of the prompt. Measured over 26 calls: about 860 input and 180 output tokens per call, most of the output being the model's thinking. The result is drawn under the prompt only and never goes into the conversation's context. A failed or timed-out call (8 s) leaves the stack as it was.

Each call is also written as one JSON line to `~/.claude/mind-stack/calls.jsonl` (the newest 200 kept): time, latency, the stack before, the first 60 characters of the prompt, the whole request sent to `haiku`, its answer, the verdict and the tokens. `/topic log` shows the totals.

## Notes

- The command output and listings are in Korean; labels follow the language you write in.
- The stack is kept per session and survives a resume; `/clear` empties it.
- Tests: `claude plugin test .`
