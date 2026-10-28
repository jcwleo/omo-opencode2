# omo-opencode2

omo(Senpi 세트)의 스킬, 프롬프트, 서브에이전트, 모델별 메인 프롬프트를 OpenCode 2 플러그인으로 옮긴 프로젝트입니다.
OpenCode 2 서버 플러그인(`@opencode/plugin`)만 다루며, V1(`@opencode-ai/plugin`) 호환 코드는 두지 않습니다.

- 대상 OpenCode: 2.1.4 이상 (`@opencode/plugin`은 2.1.4로 고정, e2e는 OpenCode 2.2.0 서버에서 확인)
- 출처: omo(oh-my-openagent, Senpi)의 스킬·에이전트·카테고리·프롬프트 프리셋(MIT)·MCP 실행 파일·메모리 코드를 한 번 가져와 옮겼습니다. 이후로는 upstream을 따라가지 않고 이 저장소에서 직접 관리합니다. 가져온 파일과 고치는 곳은 아래 "관리"에 있습니다.

## 하는 일

| 기능 | 구현 | OpenCode 2 API |
|---|---|---|
| 스킬 19개 등록 (ultrawork의 GPT-6 Astra 변형은 스킬로 등록하지 않음) | `src/skills/` | `ctx.skill.transform` |
| `/<스킬>` 커맨드 19개 | `src/commands/` | `ctx.command.transform` → 스킬을 붙여 `ctx.session.prompt` |
| `ulw`/`ultrawork` 키워드 → 세션에서 처음이면 ultrawork 지시문, 이미 들어 있으면 한 줄 알림 (대화 압축 뒤에는 다시 전문) | `src/prompts/` | `session.hook("prompt")`에서 `prompt.skills`에 추가, `session.hook("compaction")`으로 재무장 |
| 요청 모델이 GPT-6 Astra면 대화 속 ultrawork 본문을 Astra 변형으로 교체 (반대도 마찬가지) | `src/prompts/` | `session.hook("context")`에서 `messages` 교체 |
| `ulw-plan`·`ulw-research` 언급 → 스킬 포인터 | `src/prompts/` | 그 턴의 사용자 메시지에 포인터를 붙이고, 이후 모든 요청의 `session.hook("context")`에서 같은 메시지(ID 기준)에 다시 붙임. ultrawork 한 줄 알림도 같음 |
| 모델별 메인 프롬프트 (Senpi 프리셋 33개) | `src/prompts/main-prompt.ts`, `src/prompts/presets.ts` | 자기 system이 없는 에이전트(build, general, plan, `omo/<카테고리>`)의 첫 system 부분을, 그 요청의 실제 툴 목록(`event.tools`)으로 렌더링한 프리셋으로 교체. 첫 문장의 이름은 GPT 계열 `Codex`, Claude 계열 `Claude Code`, 나머지 `omo` (Anthropic 인증 플러그인이 `You are OpenCode`가 든 문단을 지우므로 OpenCode는 쓰지 않음) |
| 서브에이전트 17개 (`omo/*`), 기본 `general`·`explore` 제거 | `agents/omo/*.md`, `src/agents/` | md의 description·permissions·본문을 읽어 `ctx.agent.transform`의 `editor.update(<새 id>)`로 등록 (문서에 `add`가 없어 update가 새 에이전트를 만드는 동작을 씀, e2e가 확인). 사용자의 `agents.<id>` 설정은 그 뒤에 적용되어 우선함 |
| 에이전트별 모델 선택 | `src/agents/` | `omo.json[c]`의 `categories`/`agents` 모델 목록을 앞에, 기본 폴백 체인을 뒤에 두고 `ctx.model.list()`와 맞춰 `ctx.agent.transform`으로 지정 |
| 내장 MCP: context7, grep_app, ast_grep (Code Mode), lsp (`lsp_*` 일반 툴) | `src/mcp/` | `ctx.mcp.transform` (같은 이름을 사용자가 설정했으면 건드리지 않음) |
| 주석 검사 (write/edit/patch 뒤) | `src/hooks/comment-checker.ts` | `ctx.tool.hook("execute.after")`로 결과에 "comment-checker found issues in ..." 추가 |
| LSP 편집 후 진단 | `src/hooks/lsp-diagnostics.ts` | 같은 훅에서 lsp-daemon 클라이언트로 진단을 받아 "LSP errors detected in ..." 추가 |
| ulw-execute 이어가기 | `src/hooks/ulw-execute-continuation.ts` | `session.execution.succeeded` 뒤 `.omo/boulder.json`에 이 세션(`opencode2:<id>`)의 진행 중 계획이 있으면 `ctx.session.synthetic`으로 다음 턴 주입 (연속 8회, 같은 상태 반복 금지) |
| omo 메모리 (Senpi와 같은 저장소) | `src/memory/` | 신원은 omo 규칙 그대로(`~/.omo/memory/agents/<id>/repo`, `OMO_MEMORY_HOME`, omo.json의 `memory.agent`/`auto_identity`). 세션 첫 턴의 HEAD로 고정한 `<memory>` 블록을 `session.hook("context")`에서 system에 추가하고 압축 뒤에만 다시 고정. `memory` 툴(7개 명령)은 `ctx.tool.transform`으로 등록하고 쓰기 잠금·git 커밋·`Omo-Session: opencode2:<id>` 트레일러·동의 확인을 Senpi와 같게 처리. 고정 뒤 바뀐 파일과 저장 넛지(`memory.nudge`, 기본 10턴)는 그 턴의 사용자 메시지 뒤에 `<memory_notice>`로 붙이고 이후 요청에서도 그 메시지에 남김. 저장소 `skills/`는 스킬로 등록 |
| 카테고리 프롬프트 (모델별 분기 포함) | `src/agents/` | `omo/<카테고리>` 요청에만 `session.hook("context")`로 `<Category_Context>` 추가 |

턴마다 붙이는 문구(포인터, ultrawork 알림, `<memory_notice>`)는 system이나 "가장 최근 사용자 메시지"가 아니라 그 턴을 연 사용자 메시지에 붙이고, 다음 턴부터도 같은 자리에 같은 바이트로 다시 붙입니다. provider의 프롬프트 캐시는 직전 요청과 처음 달라지는 바이트부터 놓치므로, 문구가 빠지거나 옮겨 가면 그 뒤 대화 전체를 다시 캐시에 씁니다(omo #6199·#6889와 같은 원칙). 툴을 쓰는 동안 OpenCode가 넣는 `Instructions from:` 사용자 메시지로도 문구가 옮겨 가지 않습니다. 붙인 자리는 서버 메모리에만 있어서, 서버를 다시 띄우면 그 전 턴의 문구는 빠지고 캐시를 한 번 놓칩니다.

키워드 감지는 Senpi의 `strip-quoted-regions.ts`를 그대로 가져와 같은 규칙을 씁니다. 따옴표·코드·인용 안의 언급, "do not use ..." 같은 부정문, 경로나 식별자의 일부는 무시합니다. 위임된 하위 세션에서는 동작하지 않습니다.

프리셋 조립, 모델 → 프리셋 매칭, 카테고리 append의 GPT 분기, GPT-6 Astra 판별은 원본 함수를 `bun build`로 한 번 묶어 둔 `src/prompts/model-variants.generated.js`를 씁니다. Senpi처럼 요청마다 실제 툴로 렌더링하므로 GPT 모델은 `patch`, 그 밖의 모델은 `edit`/`write` 지시를 받고, 카테고리 레인에는 막힌 `subagent`·`question`이 나오지 않습니다(deep-*·unspecified-*의 `subagent`는 `omo/explore`·`omo/librarian`만 열려 있어 나옴). OpenCode 기본 프롬프트가 넣던 툴 안내 문장도 `## Tool Guidelines`로 함께 붙습니다. 맞는 프리셋이 없는 모델(예: `opencode/big-pickle`)은 OpenCode 기본 프롬프트를 그대로 씁니다.

## 구조

```text
omo-opencode2/
├── index.ts                  # 로컬 로드용 루트 엔트리 (src/index.ts를 다시 export)
├── src/
│   ├── index.ts              # Plugin.define({ id: "omo-opencode2", setup })
│   ├── skills/               # skills/*/SKILL.md 등록, 스킬 id 상수
│   ├── prompts/              # 키워드·ultrawork 훅, 메인 프롬프트 교체, 런타임 프리셋 렌더러, 생성된 번들
│   ├── commands/             # 스킬 슬래시 커맨드
│   ├── agents/               # 모델 라우팅(omo.json 반영), 카테고리 프롬프트, routing.generated.json
│   ├── mcp/                  # 내장 MCP 서버 등록
│   ├── hooks/                # 주석 검사, LSP 편집 후 진단, ulw-execute 이어가기
│   ├── memory/               # omo 메모리: 투영, 턴 알림·넛지, memory 툴, 저장소 스킬
│   └── omo/                  # omo 원본 함수 번들(core.generated.js)과 공용 도우미
├── agents/omo/               # 서브에이전트 17개 정의 (frontmatter: description·permissions, 본문: system 프롬프트)
├── skills/                   # 스킬 (각 SKILL.md와 부속 파일)
├── runtime/                  # ast-grep-mcp, lsp-daemon, 메모리 git 훅 검사기 memory-hook.js (모두 JS 번들)
└── tests/e2e/                # 격리 서버 e2e: harness, 요청 기록 probe 플러그인, 대역 provider, live·scripted 테스트
```

## 관리

모든 파일을 이 저장소에서 직접 고칩니다. 이름에 `generated`가 붙은 파일도 처음에 생성했을 뿐 지금은 손으로 관리하는 원본입니다.

| 바꿀 것 | 고칠 곳 |
|---|---|
| 서브에이전트 설명·권한·프롬프트, 에이전트 추가·삭제 | `agents/omo/<이름>.md` (추가·삭제 때는 `src/agents/routing.generated.json`에도 같은 id의 체인을 넣고 뺌. 둘이 다르면 플러그인 로드가 실패함) |
| 에이전트·카테고리별 기본 모델 폴백 체인 | `src/agents/routing.generated.json` (`providers` 중 연결된 첫 provider·`model`·`variant`, 위에서부터 처음 쓸 수 있는 것) |
| 카테고리 프롬프트(`<Category_Context>`)·모델별 메인 프롬프트 프리셋 | `src/prompts/model-variants.generated.js` (bun 번들, 주석으로 원본 파일 경로가 남아 있음), 프리셋 치환은 `src/prompts/presets.ts` |
| 스킬 | `skills/<이름>/SKILL.md`와 부속 파일 (공개 스킬 개수가 바뀌면 `tests/e2e/live.test.ts`의 19도 고침) |
| MCP 실행 파일, 메모리 훅 | `runtime/`, omo 원본 함수는 `src/omo/core.generated.js` |

고친 뒤에는 `bun run typecheck`와 `bun run test:e2e:stub`으로 확인합니다.

## 설치

OpenCode 2의 플러그인 CLI로 GitHub에서 바로 설치합니다. clone이나 `bun install`은 필요 없습니다.

필요한 것

- OpenCode 2.1.4 이상 (2.2.0에서 확인). 플러그인은 node 기본 모듈만 쓰고, 로컬 MCP(ast_grep, lsp)와 메모리 git 훅은 OpenCode 실행 파일로 돌아서 bun·node는 따로 없어도 됩니다.
- git: GitHub에서 플러그인 설치, omo 메모리 저장소.
- 선택 (없으면 그 기능만 빠짐, omo와 같은 조건)
  - ast-grep CLI `sg`: `ast_grep` MCP. `npm i -g @ast-grep/cli`나 `brew install ast-grep`, 또는 `OMO_AST_GREP_SG_PATH`에 바이너리 경로.
  - 언어 서버: 편집 후 LSP 진단과 `lsp_*` 툴. TypeScript는 `npm i -g typescript-language-server typescript` (프로젝트에 TypeScript 7만 있으면 진단이 나오지 않음, 아래 "확인한 사실" 참고).
  - `gh`: explore·librarian의 GitHub 조회.
  - 네트워크: context7·grep_app 원격 MCP, comment-checker 바이너리 첫 다운로드(못 받으면 주석 검사만 꺼짐).

1. 플러그인을 설치합니다. OpenCode가 패키지를 받아 캐시에 두고 전역 `~/.config/opencode/opencode.json[c]`의 `plugins`에 추가합니다.

   ```sh
   opencode plugin add github:jcwleo/omo-opencode2
   ```

2. 같은 전역 설정에 `experimental` 두 값을 넣습니다(아래 "필수 설정"). 설정은 저장하면 바로 다시 읽으므로 재시작은 필요 없습니다.

| 할 일 | 명령 |
|---|---|
| 업데이트 확인·적용 | `opencode plugin check`, `opencode plugin update github:jcwleo/omo-opencode2` |
| 특정 버전에 고정 | `opencode plugin add github:jcwleo/omo-opencode2#<태그 또는 커밋 해시>` (전체 커밋 해시는 자동 업데이트 대상에서 빠짐) |
| 제거 | `opencode plugin remove github:jcwleo/omo-opencode2` |
| 설치 확인 | `opencode plugin list` |

플러그인 옵션을 주려면 `plugins`에 추가된 문자열 항목을 아래 예시처럼 `{ "package": ..., "options": ... }` 객체로 바꿉니다. 프로젝트 하나에만 쓰려면 CLI 대신 그 프로젝트의 `opencode.json[c]` `plugins`에 같은 문자열을 넣습니다. 예전처럼 clone한 경로를 `plugins`에 넣어 두었다면 그 항목을 지우고 위 명령으로 바꿉니다(이 저장소를 고치면서 쓸 때만 경로 방식을 씁니다, 아래 "개발").

플러그인이 `omo/*` 서브에이전트 17개를 `agents/omo/*.md`에서 읽어 직접 등록하고, 역할이 겹치는 OpenCode 기본 서브에이전트 `general`과 `explore`를 지웁니다(`explore`는 `omo/explore`, `general`은 `omo/deep-*`·`omo/unspecified-*`와 겹쳐 메인 에이전트가 omo 라우팅을 건너뛸 수 있음). 기본 에이전트를 남기려면 플러그인 옵션 `"removeBuiltinSubagents": false`를 줍니다. 예전처럼 `~/.config/opencode/agents/omo`에 에이전트 파일을 복사해 두었다면 지웁니다(남아 있으면 같은 정의가 설정 쪽에서 한 번 더 적용됨).

**필수 설정** `experimental`의 두 값은 OpenCode 설정이라 플러그인이 바꿀 수 없으므로 직접 넣어야 합니다.

- `"todo": true`: 메인 프롬프트와 ulw 스킬이 쓰는 `todowrite` 툴이 생깁니다.
- `"subagent_depth": 2`: deep-*·unspecified-* 레인은 카테고리 프롬프트가 explore·librarian을 병렬로 띄우라고 지시하고, 권한도 `omo/explore`·`omo/librarian` 호출만 허용합니다. OpenCode 기본값(1)에서는 서브에이전트가 다시 서브에이전트를 띄울 수 없어 이 지시를 따를 수 없습니다. 다른 레인과 explore·librarian 자신은 아무것도 띄우지 못하므로 깊이는 2를 넘지 않습니다.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:jcwleo/omo-opencode2",
      "options": {
        // 선택: 폴백 체인 대신 쓸 모델을 에이전트별로 지정
        "models": { "omo/quick": "anthropic/claude-haiku-5-5", "omo/deep-low": "openai/gpt-6.1-sol#medium" },
        // 선택: false면 모델별 메인 프롬프트 교체를 끄고 OpenCode 기본 프롬프트를 씀
        "mainPrompt": true,
        // 선택: 각각 false로 끌 수 있음 (기본값 모두 true)
        "mcp": true,
        "commentChecker": true,
        "lspDiagnostics": true,
        "ulwExecuteContinuation": true,
        "memory": true,
        // 선택: false면 OpenCode 기본 서브에이전트 general·explore를 지우지 않음
        "removeBuiltinSubagents": true
      }
    }
  ],
  // 필수: 플러그인이 바꿀 수 없는 OpenCode 설정
  "experimental": { "todo": true, "subagent_depth": 2 }
}
```

모델 우선순위는 플러그인 옵션 `models` → `~/.omo/omo.json[c]`와 프로젝트 `.omo/omo.json[c]`(HOME 아래 프로젝트만, omo 규칙 그대로)의 `categories`·`agents` 모델 목록 → 기본 폴백 체인입니다. omo 설정의 Senpi provider 이름은 OpenCode 이름으로 바꿉니다(`chatgpt-subscription` → `openai`, `anthropic-subscription`·`anthropic-api` → `anthropic`). `reasoning`은 같은 이름의 variant(`low`~`max`)로 넘기고, 모델에 그 variant가 없으면 생략합니다.
기본 폴백 체인(`src/agents/routing.generated.json`)은 omo 체인을 가져온 것이고, 카테고리 9개(quick 제외)는 그 앞에 이 플러그인이 정한 기본값 두 개(OpenAI·Anthropic 모델 하나씩)를 둡니다. 그래서 omo 설정이 없어도 deep-high·unspecified-high는 `claude-opus-5-5#xhigh`, unspecified-low는 `gpt-6.1-sol#high`처럼 골라지고, 두 모델 다 없을 때만 그 뒤의 omo 체인으로 내려갑니다.
설정의 `agents`에 사용자가 직접 모델을 적어 두면 플러그인은 그 값을 덮어쓰지 않습니다.
체인에 맞는 모델이 하나도 없으면 모델을 지정하지 않으므로 세션 모델을 그대로 씁니다.

## 개발

```sh
git clone https://github.com/jcwleo/omo-opencode2.git ~/omo-opencode2
cd ~/omo-opencode2 && bun install
bun run typecheck
```

고친 내용을 바로 써 보려면 `plugins`의 `github:jcwleo/omo-opencode2`를 clone 위치의 절대 경로(`/Users/<you>/omo-opencode2`)로 바꿉니다. 로컬 경로 플러그인은 파일을 저장하면 다시 읽고, 반영이 안 되면 `opencode service restart`를 합니다. 커밋을 push한 뒤에는 다시 `github:` 항목으로 돌아가 `opencode plugin update`로 받습니다.

## 테스트

```sh
bun run test:e2e        # 실제 opencode/glm-5.3-flash-free로 live 테스트 + GPT 전용 경로 scripted 테스트
bun run test:e2e:stub   # 같은 live 테스트를 테스트 프로세스 안의 대역 모델로 (무료 한도·네트워크 모델 호출 없음)
OMO_E2E_MODEL=opencode/deepseek-v4.1-flash-free bun test tests/e2e/live.test.ts   # 다른 모델로
OMO_E2E_MODEL='openai/gpt-6.1-sol#high' bun test tests/e2e                          # 실제 OpenCode에 연결한 provider로
OMO_E2E_KEEP=1 bun run test:e2e:stub                                                # 샌드박스(서버 로그, probe.jsonl) 남기기
```

- 각 테스트 파일은 임시 폴더에 HOME·XDG·`OMO_MEMORY_HOME`을 따로 두고 `opencode serve`를 띄웁니다. 픽스처 프로젝트에는 AGENTS.md(루트·하위), `.omo/omo.jsonc`, TypeScript가 들어 있습니다. 마지막 테스트가 실제 `opencode.db` 세션 수와 실제 memory 루트가 그대로인지 확인합니다.
- 검증은 모델의 답이 아니라 `tests/e2e/probe` 플러그인이 `session.hook("http.request")`로 기록한 실제 요청(system, 툴 결과, 사용자 메시지)과 저장소·파일 상태로 합니다. 모델에 의존하는 테스트는 "이 툴을 이 JSON 입력으로 정확히 한 번 호출하라"고 지시하고, 모델이 따르지 않으면 실제로 본 툴 호출 목록과 함께 실패합니다.
- `live.test.ts`(24개, ast-grep CLI가 없으면 ast_grep 응답 테스트 1개는 건너뜀): 스킬·커맨드 등록, MCP 4개 연결, omo.jsonc·`models` 라우팅, 플러그인의 omo 에이전트 등록·기본 general/explore 제거, glm 프리셋, ultrawork(최초·알림·압축 뒤 재무장), ulw-plan·ulw-research 포인터, 스킬 커맨드, explore 읽기 전용 툴, quick 카테고리 프롬프트, 주석 검사, LSP 편집 후 진단과 `lsp_diagnostics`, Code Mode 카탈로그의 ast_grep·context7·grep_app와 ast_grep 실제 응답, 하위 AGENTS.md, memory 7개 명령·동의·변경 알림·압축 뒤 재고정·넛지, 포인터·변경 알림·넛지·`Instructions from:`이 섞인 턴들에서 모든 요청이 직전 요청의 system과 대화를 그대로 반복하는지(프롬프트 캐시 안정성), ulw-execute 이어가기로 계획 완료, 격리 확인.
- `scripted.test.ts`(4개): glm이 갈 수 없는 GPT 전용 경로(patch 툴 구성, patch 추가·수정의 주석 검사와 LSP, GPT-6 Astra ultrawork 교체)를, 테스트가 정한 툴 호출을 돌려주는 대역 provider로 확인합니다.
- `test:e2e:stub`의 대역 모델은 모델 id가 `glm-5.3-flash-free`라 프리셋·카테고리 경로가 실제 glm과 같고, 프롬프트의 JSON 지시를 그대로 수행합니다(`tests/e2e/stub-provider.ts`). 플러그인 동작은 확인하지만 실제 모델이 지시를 따르는지는 `test:e2e`만 확인합니다.
- `opencode`가 아닌 provider를 고르면 실제 OpenCode에 저장된 그 provider의 자격 증명을 읽기 전용으로 가져와 `credential.create` API로 샌드박스 서버에 등록합니다. OAuth는 access 토큰만 넘기고 refresh 토큰은 비웁니다(샌드박스가 토큰을 갱신하면 실제 로그인이 풀리므로). access 토큰이 1시간 안에 만료되면 시작하지 않습니다.
- OpenCode 무료 모델은 머신(또는 IP) 단위로 하루 사용량이 정해져 있고 00:00 UTC에 초기화됩니다. 한도에 걸리면 `test:e2e`는 남은 시간과 함께 실패합니다.
- LSP 테스트는 dev 의존성 `typescript-tsserver`(`npm:typescript@^5`)를 픽스처의 `node_modules/typescript`로 씁니다. TypeScript 7에는 `typescript-language-server`가 찾는 `tsserver.js`가 없어서, TypeScript 7만 있는 프로젝트(이 저장소 포함)에서는 TypeScript 편집 후 진단이 "TypeScript 설치를 찾을 수 없음"만 냅니다.

## 옮기지 않은 것과 OpenCode 2에서 달라지는 것

| 스킬 | 이유 |
|---|---|
| mass-ulw, dag-library | Senpi의 workflow DAG 엔진 필요 |
| ulw-loop | Senpi goal 툴(create_goal/update_goal)과 루프 런타임 필요 |
| visualize | show_html_page 툴 필요 |
| lsp-setup | omo 자체 LSP 툴 설정용, OpenCode 2는 읽지 않음 |
| onboarding, give-me-tips | OmO Native 전용 |

OpenCode 2에 없는 Senpi 기능은 프롬프트에서 이렇게 바꿨습니다.
- team 툴(`team_create`, `task_send`, ...): 멤버마다 백그라운드 `subagent`를 띄우고 `sessionID`로 다음 라운드를 보냄. 공유 상태는 파일로 관리.
- `todo` 툴: OpenCode 2의 `todowrite`는 설정 `experimental.todo: true`일 때만 생깁니다. 있으면 그것을, 없으면 응답 속 체크리스트(ultrawork는 노트패드의 `## Todo`)를 쓰도록 안내합니다.
- Senpi의 읽기 전용 실행기(explore, librarian, plan-consultant, plan-reviewer): shell은 `gh` 조회 명령(`gh search`, `gh repo|issue|pr view`, `gh release view|list`, GET만 하는 `gh api`)만 허용하고, HTTPS 조회는 `webfetch`로 옮겼습니다. `gh api`의 `-X`·`-f`·`--input` 같은 변경 플래그는 막지만, 권한 패턴 기반이라 Senpi 실행기의 인자 검사만큼 엄격하지는 않습니다.
- eval 커널, `tool.monitor`: 병렬 툴 호출 묶음, `shell`/`subagent`의 `background: true` 완료 알림.
- ulw-execute 세션 ID: shell의 `OPENCODE_SESSION_ID`로 알 수 있다고 스킬에 안내하고, boulder.json에는 `opencode2:<id>`로 적습니다.
- ulw-loop SDK, OmO Desktop 브라우저: 없음으로 명시하고 대안 안내.
- omo 메모리: kibitzer recall, reflection/dream/facts 백그라운드 학습, `/memory`·`/reflect` 같은 커맨드, 동기화는 옮기지 않았습니다. Senpi의 in-process 러너와 `senpi -p` 자식 프로세스가 있어야 동작하기 때문입니다. 그래서 컴파일된 리마인더의 "`<recalled-memory>`가 저절로 온다"는 문장은 "`read`로 읽으라"는 문장으로 바꾸고, OpenCode 툴이 펼치지 않는 `$MEMORY_DIR`의 실제 경로를 `<memory_metadata>`에 넣습니다. 세션 고정과 사용자 턴 수는 서버 메모리에만 있어서, 서버를 다시 띄우면 다음 턴에 HEAD로 다시 고정하고 턴 수도 0부터 셉니다. 저장소의 `memory-discipline` 스킬은 저장소 데이터를 그대로 등록하므로 Senpi 커맨드(`/reflect` 등)를 언급합니다.
- Senpi의 주석 검사는 apply_patch에 파일 경로만 넘기는데, 이 검사기는 경로만으로는 주석을 찾지 못합니다. 그래서 patch는 파일마다 새 파일이면 write(전체 내용), 수정이면 edit(이전→이후)로 바꿔 검사합니다.
- plan-consultant·plan-reviewer의 plan-gate는 강제하지 않고 지시문으로만 남김.

일부러 남긴 표현: `omo/*` 에이전트 이름과 `.omo/plans`·`.omo/evidence` 같은 산출물 경로(스크립트 계약이고 Senpi와 계획 파일을 공유), coding-agent-sessions의 검색 대상 플랫폼 이름(senpi, OMO), refactor·debugging에서 "team 툴이 있을 때만" 적용되는 섹션.

## OpenCode 2.1.4·2.2.0에서 확인한 사실

- 로컬 플러그인 디렉터리는 `package.json`의 `exports`/`main`을 무시하고 루트 `server.ts` 또는 `index.ts`만 읽습니다. 없으면 로그 없이 건너뜁니다.
- `opencode plugin list`는 전역 패키지 플러그인만 보여 주고 백그라운드 서비스를 띄웁니다. 로드 확인은 아래처럼 합니다.
- `event.subscribe`에 문서의 `types` 필터가 없어 직접 거릅니다.
- 본문이 빈 에이전트 md는 OpenCode 기본 프롬프트를 유지하고, 본문이 있으면 system을 대체합니다.
- OpenCode도 자체 모델별 기본 프롬프트(GPT, GPT-Astra, Claude, Kimi 등)로 첫 system 부분을 바꾸지만, 설정 플러그인의 context 훅이 그 뒤에 실행되므로 이 플러그인의 프리셋이 최종 적용됩니다.
- 모델 ID에 `gpt-`가 들어가고 `oss`·`gpt-4`가 아니면 OpenCode가 `edit`/`write`를 빼고 `patch`를 줍니다. 그 밖의 모델에는 `patch`가 없습니다.
- 권한 규칙은 마지막에 맞는 규칙이 이기고, shell 규칙은 명령마다 검사합니다.
- 실행이 끝나면 `session.execution.succeeded`(또는 `failed`/`interrupted`)가 오고 `session.idle`은 오지 않습니다.
- MCP 서버는 `codemode: true`면 Code Mode 카탈로그(`tools.<server>.<tool>`)로, `false`면 일반 툴로 들어갑니다. 일반 툴은 MCP 툴 이름 그대로 노출되고 권한 action도 그 이름입니다(`lsp_diagnostics`).
- shell 명령에는 `OPENCODE_SESSION_ID` 환경변수가 있습니다.
- 플러그인은 `ctx.tool.transform`의 `add`로 툴을 직접 만들 수 있습니다(`options.codemode: false`면 일반 툴). execute에서 던진 오류는 모델에 `{"error":{"message":"<툴 이름>: ..."}}`로 전달됩니다.
- 하위 디렉터리의 파일을 읽으면 OpenCode가 그 디렉터리의 AGENTS.md를 `Instructions from: <경로>` 사용자 메시지로 스스로 넣습니다. 그래서 Senpi의 nested-agents-md는 옮기지 않습니다(한때 옮겼더니 같은 내용이 두 번 들어갔습니다).
- ChatGPT 계정으로 연결한 `openai` provider는 Responses API를 WebSocket으로 보냅니다(`session.hook("http.request")`가 아니라 `experimental.ws.send`/`receive`). 프레임은 `previous_response_id`로 이어 가서 새 입력 항목만 실립니다.
- 서버는 세션의 모델을 프로세스 cwd가 아니라 `PWD` 환경변수가 가리키는 위치의 설정에서 찾습니다. 다른 폴더에서 `opencode serve`를 띄우면 프로젝트 `opencode.jsonc`에만 있는 provider는 `model.list`에 보여도 실행 때 `provider.no-route`로 실패합니다.
- Code Mode 카탈로그는 툴이 많아지면 일부만 싣고("The catalog is partial"), 나머지는 `execute` 안에서 `search({ namespace })`로 찾습니다. 하이픈이 든 툴 이름은 `tools.context7["resolve-library-id"]`처럼 쓰입니다.
- `session.compact` API는 바로 돌아오고, 압축은 뒤이어 `compaction` 종류의 모델 요청과 실행 종료 이벤트로 끝납니다. `session.command` API는 빈 응답을 돌려줍니다.
- (2.2.0) 에이전트 editor에는 `add`가 없지만 `editor.update(<없는 id>)`가 새 에이전트를 만듭니다(기본 mode `primary`). 플러그인 transform은 설정보다 먼저 적용되어, 사용자의 `agents.<id>` 값이 이기고 권한 규칙은 플러그인 규칙 뒤에 붙습니다. `editor.remove`는 기본 에이전트도 지웁니다.
- (2.2.0) 모든 에이전트의 권한 맨 끝에 `browser *: deny`와 `skill browser: deny`가 붙습니다. 그래서 `*: deny`로 시작하는 에이전트(omo/explore 등)에도 `skill` 툴이 목록에 남지만, 호출은 앞의 `*: deny`로 모두 거부됩니다.
- (2.2.0) `opencode plugin add <git 지정자>`는 저장소를 npm 패키지처럼 받아 `~/.cache/opencode/npm/` 아래에 설치합니다. 이때 `package.json`의 `files`(index.ts, src, skills, agents, runtime)만 들어가고 `dependencies`도 함께 설치됩니다. 격리된 XDG에서 `git+file://` 지정자로 설치해 플러그인 로드, 에이전트 17개, MCP 4개 연결을 확인했습니다.
- (2.2.0) 로컬 stdio MCP 서버가 스스로 종료하면 상태가 `failed`("MCP server process exited with code 0")가 되고, 그 서버의 툴은 Code Mode 카탈로그에서 빠집니다. 호출해도 다시 띄우지 않으며 `/mcps`에서 다시 연결해야 돌아옵니다. 그래서 ast_grep MCP의 유휴 종료(omo 기본 10분)는 `OMO_AST_GREP_IDLE_TIMEOUT_MS=0`으로 끄고(사용자가 이 환경변수를 정하면 그 값을 씀), lsp MCP도 같은 이유로 유휴 종료가 꺼져 있습니다. OpenCode가 끝나면 두 서버 모두 부모 감시로 함께 종료됩니다.
- 플러그인 설정은 `experimental.*`(예: `subagent_depth`, `todo`)를 바꿀 수 없습니다. 플러그인 `Context`에 설정 영역이 없고, 클라이언트 `config.update`도 `shell`만 받습니다.
- 플러그인 등록 시점의 `agent.transform` 목록에는 프로젝트 `.opencode/agents`의 파일 에이전트가 없을 수 있어, 메인 프롬프트 교체는 요청마다 `ctx.agent.get`으로 판단합니다.

```sh
# 격리된 XDG로 서버를 띄워 실제 opencode.db를 건드리지 않는다
export XDG_CONFIG_HOME=/tmp/oc2/config XDG_DATA_HOME=/tmp/oc2/data XDG_STATE_HOME=/tmp/oc2/state XDG_CACHE_HOME=/tmp/oc2/cache OPENCODE_PASSWORD=dev
opencode serve --hostname 127.0.0.1 --port 48731 &
opencode api --server http://127.0.0.1:48731 agent.list --param directory=$PWD >/dev/null   # 첫 요청에 플러그인 로드
opencode api --server http://127.0.0.1:48731 plugin.list --param directory=$PWD            # omo-opencode2 active
opencode run --server http://127.0.0.1:48731 -m opencode/deepseek-v4.1-flash-free ulw what is 2 plus 2 < /dev/null
```

`opencode run`에 메시지를 따옴표 하나로 넘기면 CLI가 따옴표째 저장해서, 키워드 감지가 그 메시지를 인용으로 보고 무시합니다. 단어별 인자로 넘기세요.

## 참고 문서

- 플러그인: https://opencode.ai/v2/docs/build/plugins , https://opencode.ai/v2/docs/build/plugins/server/
- V1에서 마이그레이션: https://opencode.ai/v2/docs/build/plugins/migrate-v1/
- 에이전트: https://opencode.ai/v2/docs/agents/ · 스킬: https://opencode.ai/v2/docs/skills/ · 플러그인 설정: https://opencode.ai/v2/docs/plugins/
