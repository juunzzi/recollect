# recollect

[![CI](https://github.com/juunzzi/recollect/actions/workflows/ci.yml/badge.svg)](https://github.com/juunzzi/recollect/actions/workflows/ci.yml)

[Claude Code](https://claude.com/claude-code) 개인 세션 메모리.

모든 세션은 Claude 에게 무언가를 가르칩니다 — 결정, 함정, 취향 같은 것들. 그리고
세션이 끝나면 전부 사라집니다. recollect 는 각 세션을 오래 남을 마크다운 메모리로
증류해 내 소유의 git vault 에 저장하고, 다음 세션에서 관련 있는 것들을 다시
주입합니다.

- **vault 가 유일한 진실원** — 순수 마크다운 + git. 어떤 에디터로도 읽을 수 있고
  (Obsidian 호환), diff 가능하고, 어디로든 옮길 수 있습니다. 나머지(인덱스,
  임베딩)는 전부 파생 캐시라 언제 지워도 무손실입니다.
- **읽기는 LLM 0콜** — 하이브리드 검색(BM25 + transformers.js 로컬 임베딩, 완전
  오프라인)을 작은 상주 데몬이 제공하고, 데몬이 없으면 인라인으로 동일하게
  동작합니다.
- **쓰기는 세션당 ~1콜** — 추출은 세션 종료(또는 컴팩션) 시점에 로컬 `claude`
  CLI 로 한 번만 실행됩니다. 기존 구독을 그대로 쓰므로 API 키 관리가 없습니다.
- **훅은 절대 세션을 막지 않음** — 모든 훅은 얇은 트리거이고, 무엇이 실패해도
  exit 0 입니다.

## 설치

Node >= 20 와 `claude` CLI 가 필요합니다.

```bash
# 1. 엔진 (CLI + 데몬 + MCP 서버)
npm install -g github:juunzzi/recollect

# 2. vault — 머신 간 동기화를 위해 PRIVATE git 레포를 권장
gh repo create <you>/recollect-vault --private
recollect init --remote git@github.com:<you>/recollect-vault.git
# (로컬 전용으로 쓰려면 그냥 `recollect init` — ~/recollect-vault 에 생성)

# 3. Claude Code 플러그인 (훅 + MCP 배선)
claude plugin marketplace add juunzzi/recollect
claude plugin install recollect@recollect
```

이게 전부입니다. 새 세션부터 메모리가 쌓이기 시작합니다.

`init` 전에 플러그인부터 설치해도 아무것도 깨지지 않습니다: recollect 가 다음
세션에 짧은 셋업 안내를 주입해 무엇이 빠졌는지 (당신과 Claude 에게) 알려주고,
vault 가 생길 때까지 비활성 상태로 대기합니다. 나중에
`recollect init --remote ...` 를 다시 실행하면 기존 vault 에 remote 를 붙일 수
있습니다.

> vault 는 반드시 **private** 으로 두세요 — 업무 맥락이 계속 쌓이는 곳입니다.

## 동작 방식

```
SessionStart ──► 데몬 워밍업 + 밀린 세션 추출 + 메모리 프로필 주입
UserPromptSubmit ──► 하이브리드 검색(프롬프트) → 관련 메모리 top-5 주입
PreToolUse (Read/Edit/Write) ──► 그 파일에 얽힌 메모리 주입
Stop ──► 세션을 "pending" 으로 표시만 (LLM 0콜)
PreCompact / SessionEnd ──► 추출 LLM 이 트랜스크립트를 증류 → vault
```

추출기는 네 가지 게이트를 전부 통과한 사실만 남깁니다: 재적용 가능한가, 코드
자체에서 유도할 수 없는가, 시간이 지나도 안정적인가, 행동할 수 있을 만큼
구체적인가. 시크릿 비슷한 것이 섞인 후보는 통째로 버립니다. 기존 메모리를
대체하는 새 사실은 삭제 대신 `is_latest: false` 플래그(`supersedes`)로
과거를 보존합니다.

### vault 구조

```
your-vault/
  facts/
    fact/2026-08-11-1423-a1b2c3-some-title.md
    feedback/...
    procedural/...
```

메모리 하나가 마크다운 파일 하나입니다. YAML frontmatter(`id`, `type`, `title`,
`entities`, `files`, `tags`, `confidence`, `is_latest`, ...)와 사실 /
**Why** / **How to apply** 구조의 본문으로 이뤄집니다.

### MCP 도구

플러그인이 `search`, `get`, `related_to_file`, `remember` MCP 서버를
등록합니다 — Claude 가 필요할 때 직접 메모리를 조회하거나, "이거 기억해" 라고
말하면 즉시 저장할 수 있습니다.

## CLI

```
recollect search <query>         하이브리드 검색
recollect get <id>               메모리 하나 출력
recollect related --file <path>  파일에 얽힌 메모리
recollect remember "<text>"      수동 저장 (LLM 0콜)
recollect status                 vault + 데몬 상태
recollect reindex                로컬 임베딩 백필/정리
recollect sync                   vault git commit/pull/push
recollect server stop            데몬 중지
```

## 설정

`~/.recollect/config.json` (`init` 이 생성), env 로 프로세스별 오버라이드:

| Env | 의미 |
| --- | --- |
| `RECOLLECT_VAULT` | vault 경로 오버라이드 |
| `RECOLLECT_DISABLE=1` | 킬스위치: 훅/추출/주입 전부 비활성 |
| `RECOLLECT_NO_EMBED=1` | 임베딩 없이 lexical 검색만 |
| `RECOLLECT_EXTRACTOR` | 추출 명령 (기본 `claude`) |
| `RECOLLECT_EXTRACTOR_MODEL` | 추출기에 넘길 모델 플래그 |
| `RECOLLECT_GIT_SYNC=0` | vault 자동 commit/push 끄기 |

임베딩은 optional dependency(`@huggingface/transformers`)입니다. 설치에
실패해도 BM25 전용 모드로 전부 동작하며, 나중에 다시 `npm i -g` 후
`recollect reindex` 하면 됩니다.

## 여러 머신에서 동기화

vault 에 private git remote 를 주세요 (`recollect init --remote ...` 또는
나중에 추가). 추출이 끝날 때마다 best-effort 로 commit/push 하고, 충돌 시엔
rebase 를 중단하고 다음 기회에 재시도합니다 — 단일 사용자 vault 는 충돌이
거의 없습니다. 다른 머신에서 같은 셋업을 하면 내 메모리가 어디에나 있습니다.

## 제거

```bash
claude plugin uninstall recollect@recollect
recollect server stop
npm uninstall -g @juunzzi/recollect
rm -rf ~/.cache/recollect ~/.recollect   # 파생 데이터 + 설정
# vault 는 당신 것입니다 — 남기든 지우든 자유
```

## License

MIT
