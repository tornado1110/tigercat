<!-- i18n-source: CONTRIBUTING.md @ ea10d77c5aa02683c50f6f599b25c729839abc7c -->
> 간체 중국어판이 기준입니다. 이 번역은 원문보다 늦을 수 있으며, 기계 번역의 도움을 받았습니다. 수정은 환영합니다.

# TigerCat에 기여하기

[简体中文](../../../CONTRIBUTING.md) | [English](../en/CONTRIBUTING.md) | [日本語](../ja/CONTRIBUTING.md) | [한국어](../ko/CONTRIBUTING.md) | [Español](../es/CONTRIBUTING.md)

TigerCat을 도와 주셔서 감사합니다. 이 문서는 체크아웃을 준비하는 방법, 커밋 메시지를 어떻게 써야 하는지, pull request를 어떻게 여는지 설명합니다.

## 개발 환경

TigerCat은 Node.js 22.13 이상에서 실행됩니다(`package.json`의 `engines`를 보세요). 저장소에 `.nvmrc`가 있으면 그 파일로 해당 Node 버전을 고르세요.

```bash
git clone https://github.com/tornado1110/tigercat.git
cd tigercat
npm ci
```

pull request를 열기 전에 다음을 실행하세요.

```bash
npm run lint
npm run typecheck
npm test
```

빌드가 컴파일하는 코드를 바꿨다면 `npm run build`도 실행하세요.

이 명령이 다루는 범위는 [TESTING.md](../../../TESTING.md)에 있습니다. 실제 agent의 엔드투엔드 테스트는 CI에서 돌리지 않습니다. 유료 API 키가 필요하기 때문입니다. 그 문서는 CI가 대신 무엇을 실행하는지 설명합니다. API 키를 저장소나 pull request에 넣지 마세요.

## 커밋 메시지

커밋 메시지는 [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)를 따라야 합니다. [Release Please](../../../RELEASING.md)는 이것을 읽어 `CHANGELOG.md`를 유지하고, 릴리스 pull request를 엽니다. 이 약속을 따르지 않는 커밋은 changelog에 들어가지 않고, 버전을 올리지도 않습니다.

다음 형태를 사용하세요.

```text
<type>[optional scope][!]: <short summary>

[optional body]

[optional footer]
```

요약은 영어 명령형, 소문자로 쓰고, 끝에 마침표를 붙이지 않습니다.

| 유형 | 언제 쓰나 | 버전 상승 |
| --- | --- | --- |
| `feat` | 사용자가 볼 수 있는 능력 | minor(`0.1.0`에서 `0.2.0`) |
| `fix` | 결함 수정 | patch(`0.1.0`에서 `0.1.1`) |
| `feat!` 또는 `BREAKING CHANGE:` 꼬리말 | 호환을 깨는 변경 | 버전이 `0.x`인 동안은 minor. `1.0.0`부터는 major |
| `docs`, `test`, `chore`, `ci`, `refactor`, `perf`, `build` | 그 밖의 경우 | 없음. 그 커밋이 호환을 깨는 변경으로 표시된 경우는 제외 |

예:

```text
feat: route a stalled task to another ACP runtime

fix(client): retry a worker session that closed before the first event

docs: describe the permission ask default
```

패키지 버전이 아직 `0.x`이면, 호환을 깨는 변경은 `1.0.0`으로 건너뛰지 않고 minor를 올립니다. 그래도 꼬리말에 적으세요.

```text
feat!: drop the legacy session id field

BREAKING CHANGE: session ids from 0.1 are not accepted.
```

## 풀 리퀘스트

1. 최신 `main`에서 브랜치를 뺍니다.
2. 변경은 한곳으로 모읍니다. pull request 하나에는 목적이 하나입니다.
3. 모든 커밋에 Conventional Commits를 사용합니다. pull request가 squash로 병합되면 제목은 Conventional Commit이어야 합니다. 그 제목이 `main`의 커밋이 됩니다.
4. `npm run lint`, `npm run typecheck`, `npm test`를 실행합니다. 어떻게 테스트했는지를 포함해 pull request 템플릿을 채웁니다.
5. 비밀, 토큰, `.env` 파일, 또는 그것이 들어 있는 로그를 커밋하지 않습니다.
6. 리뷰를 기다립니다. 자신이 메인테이너이고 저장소 규칙이 허용하는 경우가 아니면, 자신의 pull request를 병합하지 않습니다.

메인테이너가 Release Please가 연 릴리스 pull request를 병합합니다. 기여자는 npm에 게시하지 않습니다. [RELEASING.md](../../../RELEASING.md)를 보세요.

## 보안

[SECURITY.md](SECURITY.md)에 적힌 대로 취약점을 비공개로 보고하세요. 보안 보고를 위해 공개 issue를 열지 말고, issue, pull request, discussion에 비밀을 붙여 넣지 마세요.

## 행동 강령

이 프로젝트는 [Contributor Covenant](../../../CODE_OF_CONDUCT.md)를 따릅니다. 참여하면 그에 동의하는 것입니다.

## 번역

이 문서의 유일한 기준은 간체 중국어입니다. 문서를 바꿀 때는 중국어를 먼저 쓰고, 번역은 그 뒤를 따릅니다. 어떤 번역이 뒤처졌는지는 다음 명령으로 봅니다.

```bash
npm run docs:i18n-check
```

각 번역의 첫 줄은 출처 표시입니다. 중국어 원문 파일의 저장소 경로와 그 파일의 git blob 해시를 적습니다. `git rev-parse HEAD:<path>`의 40자 전체이며, 줄바꿈을 LF로 맞춘 내용에 대한 `git hash-object`와 같은 값입니다.

```html
<!-- i18n-source: <path> @ <blob> -->
```

커밋 SHA는 적지 않습니다. 이 저장소는 rebase 병합만 하므로, 병합 때 커밋 SHA가 바뀌고 짧은 `%h`의 길이도 달라집니다.

이 명령은 CRLF를 LF로 변환한 뒤 원본 blob이 오래된 번역을 보고합니다. HEAD를 기준으로 변경 사항도 확인합니다. 원본 blob만 바뀌고 번역 본문이 그대로이거나 번역 본문이 원문과 같으면 0이 아닌 종료 코드를 반환합니다. 커밋된 변경 사항을 이전 리비전과 비교하려면 `-- --base <revision>`을 추가합니다. PR의 CI는 대상 브랜치와 비교합니다.

모국어 화자의 리뷰 pull request를 환영합니다. 일본어, 한국어, 스페인어는 지금 기계 번역의 도움을 받은 상태이며, 모국어 화자의 리뷰를 거치지 않았습니다.
