# mind-stack

### 삼천포로 빠져도, 돌아갈 길은 화면 아래에

```
/plugin install mind-stack --marketplace Daejun/mind-stack
```

[English](#english)

Claude Code 입력창 아래에, 지금 대화가 어떤 주제를 거쳐 여기까지 왔는지 한 줄로 보여 줍니다. 곁가지를 몇 단계 따라 들어가도 처음 하던 일이 계속 보입니다.

```
> _
  ? for shortcuts
  📚 fio bench → lease 대기 → hook 수정
```

prompt를 보낼 때마다 `haiku`를 한 번 불러 판정합니다. 판정은 따로 돌기 때문에 대화는 기다리지 않습니다. background task 알림, 예약 prompt, 다른 session에서 온 message는 판정하지 않습니다.

| 판정 | 뜻 | stack |
| --- | --- | --- |
| `same` | 직전 응답이 하던 일에 대한 후속, 정정, 대답 | 그대로 |
| `push` | 지금 주제에서 생긴 곁가지 | 위에 하나 쌓음 |
| `pop` | 앞 주제로 돌아감 | 그 위는 닫음 |
| `sibling` | 지금 곁가지는 끝났고, 앞 주제에서 새 곁가지 | 그 위는 닫고 하나 쌓음 |
| `switch` | 관계없는 새 일 | root는 두고 그 아래에 새 주제. root로 돌아오지 않은 채 한 번 더 switch하면 처음 switch한 주제가 root가 됨 |

slash command는 판정하지 않습니다. 10자 미만 prompt는 session의 첫 prompt일 때만 판정하므로, "할일 확인좀"처럼 짧게 시작해도 root가 생깁니다. 줄이 좁으면 가운데부터 줄이고 root와 지금 주제는 남깁니다: `fio bench → … → hook 수정 (6)`.

## 설치

Claude Code 입력창에서:

```
/plugin install mind-stack --marketplace Daejun/mind-stack
```

shell에서:

```
claude plugin install mind-stack --marketplace Daejun/mind-stack
```

desktop app에서는 `/plugin`이 돌지 않으니, 입력창 옆 + → Plugins → Add marketplace에 `Daejun/mind-stack`을 넣고 Add plugin을 누릅니다.

새 판으로 올릴 때:

```
claude plugin marketplace update mind-stack
claude plugin update mind-stack@mind-stack
```

설치나 update 뒤에는 Claude Code를 다시 시작해야 적용됩니다.

## 명령

| 명령 | 하는 일 |
| --- | --- |
| `/topic`, `/topic log` | stack, 닫힌 곁가지, 지금까지 쓴 haiku 호출 수와 token |
| `/topic push <label>` | 손으로 쌓기 |
| `/topic pop [n]` | 한 단계 위로, 또는 `n`번째로 돌아가기 |
| `/topic rename <label>` | 지금 주제 이름 바꾸기 |
| `/topic reset` | 비우기 |
| `/topic off`, `/topic on` | 자동 판정 끄기, 켜기 |

손으로 고친 바로 다음 prompt 하나는 판정하지 않아서 고친 것이 그대로 남습니다. 자동 판정을 끄면 줄 끝에 `(manual)`이 붙습니다.

## 설정

`/config`의 Icon 한 줄: trail 앞에 붙는 표시입니다(📚 🥞 🍡 🪆 🧠 🐾, 또는 none).

## 비용

prompt 하나에 `haiku` 호출 하나(effort `low`)이고 대화 history는 보내지 않습니다. 보내는 것은 stack label, 직전 응답 끝 400자, prompt 앞 600자입니다. 실제 대화 88개 prompt로 528번 부른 측정에서 호출당 input 약 1,250, output 약 310 token이었고, output 대부분은 model의 thinking입니다. 결과는 입력창 아래에만 그리고 대화 context에는 넣지 않습니다. 호출이 실패하거나 8초를 넘기면 stack은 그대로 둡니다.

호출마다 `~/.claude/mind-stack/calls.jsonl`에 한 줄씩 남깁니다(최근 200개). 시각, 걸린 시간, 판정 전 stack, prompt 앞 60자, `haiku`에 보낸 요청 전체와 답, 판정, token이 들어갑니다. 합계는 `/topic log`로 봅니다.

## 참고

- 명령 출력은 한국어입니다. label은 쓰는 언어를 따라갑니다.
- stack은 session마다 따로 두고, resume해도 남습니다. `/clear`하면 비웁니다.
- test: `claude plugin test .`

---

## English

### Wander off all you like; the way back stays under the prompt

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

Slash commands are not classified, nor are prompts shorter than 10 characters once the stack holds a topic (the first prompt of a session is always classified, so a short one such as "할일 확인좀" still names the root). When the line is too narrow, the middle gives way and the root and the current topic stay: `fio bench → … → hook fix (6)`.

### Install

At the prompt of a terminal session:

```
/plugin install mind-stack --marketplace Daejun/mind-stack
```

From a shell:

```
claude plugin install mind-stack --marketplace Daejun/mind-stack
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Daejun/mind-stack`, then Add plugin.

To move to a new version:

```
claude plugin marketplace update mind-stack
claude plugin update mind-stack@mind-stack
```

Restart Claude Code after installing or updating.

### Commands

| command | does |
| --- | --- |
| `/topic` or `/topic log` | show the stack, closed side topics, and the haiku calls and tokens spent so far |
| `/topic push <label>` | push a topic by hand |
| `/topic pop [n]` | go up one level, or back to item `n` |
| `/topic rename <label>` | rename the current topic |
| `/topic reset` | empty the stack |
| `/topic off` / `/topic on` | turn automatic classification off or on |

The prompt right after a manual edit is not classified, so the edit stands. With automatic classification off, the line ends in `(manual)`.

### Settings

`/config` has one row for the mod, Icon: the mark drawn before the trail (📚 🥞 🍡 🪆 🧠 🐾, or none).

### Cost

One `haiku` call per prompt, effort `low`, with no conversation history: the stack labels, the last 400 characters of the previous reply and the first 600 characters of the prompt. Measured over 528 calls on 88 prompts from real sessions: about 1,250 input and 310 output tokens per call, most of the output being the model's thinking. The result is drawn under the prompt only and never goes into the conversation's context. A failed or timed-out call (8 s) leaves the stack as it was.

Each call is also written as one JSON line to `~/.claude/mind-stack/calls.jsonl` (the newest 200 kept): time, latency, the stack before, the first 60 characters of the prompt, the whole request sent to `haiku`, its answer, the verdict and the tokens. `/topic log` shows the totals.

### Notes

- The command output and listings are in Korean; labels follow the language you write in.
- The stack is kept per session and survives a resume; `/clear` empties it.
- Tests: `claude plugin test .`
