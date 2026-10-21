# Fetchy

[Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine)용 확장 설치기. zip을 내려받아 손으로 가져오는 대신 GitHub URL로 외부 확장을 설치하고 업데이트합니다. English: [README.md](README.md)

## 기능

* **URL로 설치** — GitHub 저장소(`owner/repo`, `/tree/<브랜치>/<폴더>` URL, `owner/repo/<폴더>@<브랜치>`), raw `manifest.json` URL, `.zip` URL. 브랜치를 안 적으면 `main`, 없으면 `master`
* **보내기 전 미리보기** — 이름·버전·설명·런타임·권한(`full_page_access`는 붉은 경고), 파일 크기, README, 내려받은 코드 전문, 그리고 Marinara가 Review and Run에 표시할 콘텐츠 해시
* **변경 사항** — Marinara에 이미 있는 확장이면 현재 버전·상태, 파일별 크기 전후, 추가·삭제된 줄 수, Marinara 편집기에서 손으로 고친 코드가 있으면 경고
* **설치·업데이트·연결** — Marinara의 자체 API로 레코드를 만들거나 기존 레코드를 업데이트하고, 손으로 설치한 확장은 코드를 바꾸지 않고 연결만 합니다. 모든 설치는 사용자가 해시를 승인할 때까지 비활성
* **확장 관리** — Marinara의 외부 확장을 한 목록에서: 켜짐·꺼짐·승인 필요 표시, 권한 배지, 코드 보기, 끄기, 삭제, 리비전 되돌리기. Fetchy로 설치한 것은 업데이트 확인(하나씩 또는 모두)과 업데이트, 손으로 설치한 것은 GitHub 주소 연결. 열 때 자동 확인은 선택이며 자동 설치는 없습니다
* **리비전** — Marinara가 보관한 이전 리비전으로 되돌리기. 되돌린 코드도 다시 승인 필요
* **내보내기 / 가져오기** — 소스 목록을 JSON으로. 다른 브라우저나 다른 Marinara로 옮길 때. 코드와 비밀값은 없음
* **할 일을 알려 주는 오류** — 외부 확장 게이트 두 개, Admin Access, 허용되지 않은 호스트, CSRF, CORS, GitHub API 한도, 다운로드 중 바뀐 소스
* **변경 기록** — 설치·업데이트·연결·되돌리기·제거를 버전·해시·권한과 함께 기록 (최근 200건, 비밀값은 절대 기록하지 않음). 패널이 닫힌 사이 끝난 업데이트는 다음에 열 때 기록에 반영
* **업데이트 후 자동 승인 (확장별, 기본 꺼짐)** — 켜 두면 업데이트 뒤 Fetchy가 새 코드를 승인해 다시 켭니다. 켤 때 Marinara 승인 창과 같은 확인 두 가지에 직접 체크해야 하고, 업데이트 전에 켜져 있던 확장에만, 그리고 새 권한을 요구하지 않는 버전에만 적용됩니다. **이 옵션을 켠 확장은 저장소 주인이 올린 코드가 내 검토 없이 실행됩니다.** 믿는 제작자에게만 쓰세요
* **권한 경고** — 업데이트가 새 권한을 요구하거나, 버전은 그대로인데 코드만 바뀌었으면 크게 알림
* **한국어·영어 UI**, 라이트·다크 테마, 좁은 화면에서는 바텀 시트

## 설치

1. 서버 `.env`에 `ENABLE_EXTERNAL_EXTENSIONS=true` 를 넣고 Marinara 재시작
2. 설정 → 애드온(Addons) → 외부 확장(External Extensions): **Allow third-party extension imports** 를 켜고 `ME-Fetchy-<버전>.zip` 가져오기
3. 목록의 **Fetchy** → **Review and Run**: 코드를 읽고 해시 승인 (`SHA256SUMS.txt`의 값과 같아야 함)
4. 같은 화면(설정 → 애드온 → 외부 확장)의 가져오기 버튼 옆에 **GitHub에서 설치 (Fetchy)** 버튼이 나타남. 단축키 Alt+Shift+F, 원하면 패널에서 플로팅 버튼을 켤 수 있음

원격(localhost가 아닌) Marinara는 서버 `.env`의 `ADMIN_SECRET`을 설정 → Admin Access에 입력해야 합니다. Fetchy 자신을 업데이트하려면 소스에 `FigCake/ME.Fetchy`를 추가하세요.

## 안전한가요

Fetchy는 설치 도우미일 뿐입니다. 코드를 내려받아 Marinara에 **꺼진 상태로** 넣어 두기만 하고, 직접 실행하지는 않습니다. 켜는 것은 사용자입니다(확장별로 자동 승인을 켠 경우만 예외): 설정 → 애드온 → 외부 확장에서 코드를 보고 **Review and Run**으로 승인해야 돌아갑니다. Fetchy가 미리 보여 주는 해시와 그 화면의 해시가 같으면 받은 그대로입니다.

업데이트도 같습니다. 새 코드가 들어가면 확장은 다시 꺼지고, 승인해야 다시 켜집니다. 그래서 모르는 사이에 바뀐 코드가 돌아가는 일은 없습니다.

GitHub에서 파일을 받을 때 로그인이나 토큰은 쓰지 않습니다. 공개 저장소만 됩니다.

## 내 확장을 Fetchy로 설치되게 하려면

저장소에 이 두 파일만 있으면 됩니다.

```
manifest.json      ← Marinara 외부 확장 매니페스트 (zip 가져오기에 쓰는 것과 같음)
extension.js       ← manifest.json의 jsPath가 가리키는 파일
```

둘을 저장소 맨 위에 두면 사용자는 `owner/repo`만 입력합니다. 폴더 안에 두어도 되는데, 그러면 사용자가 `owner/repo/폴더`를 입력합니다.

* 새 버전을 올릴 때 `manifest.json`의 `version`을 올리세요. Fetchy가 그걸 보고 업데이트를 알립니다.
* `capabilities`는 비어 있어도 꼭 적으세요 (`[]`). 없으면 Marinara가 구형 확장으로 봅니다.
* GitHub Releases에 올린 zip은 브라우저가 받을 수 없습니다. zip으로 배포하려면 저장소 파일로 커밋하고 그 파일 주소를 알려 주세요.

## 요구 사항

* Marinara Engine 2.5.0 이상, 외부 확장 허용
* zip 소스를 쓰려면 `DecompressionStream`을 지원하는 브라우저 (Chrome, Edge, Firefox, Safari 16.4+)

License: CC BY-NC 4.0.
