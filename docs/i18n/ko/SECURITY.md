<!-- i18n-source: SECURITY.md @ 023e9ea6731ad9ceead7895dbe7c0765d2646630 -->
> 간체 중국어판이 기준입니다. 이 번역은 원문보다 늦을 수 있으며, 기계 번역의 도움을 받았습니다. 수정은 환영합니다.

# 보안 정책

[简体中文](../../../SECURITY.md) | [English](../en/SECURITY.md) | [日本語](../ja/SECURITY.md) | [한국어](../ko/SECURITY.md) | [Español](../es/SECURITY.md)

## 취약점 보고

보안 취약점은 [GitHub Private Vulnerability Reporting](https://github.com/tornado1110/tigercat/security/advisories/new)으로 비공개 보고하세요.

의심되는 취약점에 대해 공개 issue, discussion, pull request를 열지 마세요. 공개 글을 쓰기 전에, 메인테이너가 확인하고 고칠 시간을 주세요.

issue, pull request, 커밋, 로그, discussion에 비밀을 올리지 마세요. 여기에는 API 키, 토큰, 비밀번호, 세션 cookie, 비공개 엔드포인트가 포함됩니다. 비밀이 이미 새었다면 먼저 폐기하고, 그다음 위의 비공개 경로로 그 노출을 보고하세요.

## 지원하는 버전

TigerCat은 아직 1.0 이전입니다. 보안 수정은 최신 릴리스에만 들어갑니다.

## 보안 모델

TigerCat은 worker agent를 조율합니다. 자격 증명을 보관하는 곳이 아니며, 체크아웃을 스스로 수정하지도 않습니다.

1. API 키와 토큰은 환경 변수, 또는 그 runtime 자신의 인증으로 제공합니다. 커밋되지는 않습니다. 오류 텍스트와 이벤트 페이로드는 출력하거나 저장하기 전에 가립니다. 그 패턴과 덮지 못하는 경우는 [docs/operations.md](operations.md)에 있습니다. `config.toml`은 비밀 저장소가 아닙니다.
2. 자격 증명은 모델의 컨텍스트에 들어가서는 안 됩니다. coordinator의 prompt, worker의 prompt, 도구 결과, 이벤트 요약 어디에도 넣을 수 없습니다.
3. Worker의 권한 요청 기본값은 `ask`입니다. TigerCat은 기본적으로 그 요청을 자동 승인하지 않습니다.
4. coordinator는 코드를 직접 수정할 수 없습니다. 작업을 worker agent에 넘길 뿐입니다.
